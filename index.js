const path = require("path");
const _ = require("lodash");
const chalk = require("chalk");
const yaml = require("js-yaml");
const fs = require("fs");

const certStatuses = ["PENDING_VALIDATION", "ISSUED", "INACTIVE"];

class ServerlessAppSyncCloudFrontPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      "package:createDeploymentArtifacts": this.hookDecorator.bind(this, this.createDeploymentArtifacts),
      "aws:info:displayStackOutputs": this.hookDecorator.bind(this, this.printSummary),
    };
  }

  async hookDecorator(lifecycleFunc) {
      // setup AWS resources
      this.initAWSResources();

      return await lifecycleFunc.call(this);
  }

  initAWSResources() {
      const credentials = this.serverless.providers.aws.getCredentials();
      const acmCredentials = Object.assign({}, credentials, {
        region: "us-east-1",
      });
      this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);
      this.route53 = new this.serverless.providers.aws.sdk.Route53(credentials);
  }

  async createDeploymentArtifacts() {
    if (this.getConfig("enabled", true) !== false) {
      const baseResources = this.serverless.service.provider
        .compiledCloudFormationTemplate;

      const filename = path.resolve(__dirname, "resources.yml");
      const content = fs.readFileSync(filename, "utf-8");
      const resources = yaml.safeLoad(content, { filename });

      await this.prepareResources(resources);
      return _.merge(baseResources, resources);
    }
  }

  async printSummary() {
    const awsInfo = _.find(
      this.serverless.pluginManager.getPlugins(),
      (plugin) => plugin.constructor.name === "AwsInfo"
    );

    if (!awsInfo || !awsInfo.gatheredData) {
      return;
    }

    const { outputs } = awsInfo.gatheredData;
    const apiDistributionDomain = _.find(
      outputs,
      (output) => output.OutputKey === "AppSyncApiDistribution"
    );

    if (!apiDistributionDomain || !apiDistributionDomain.OutputValue) {
      return;
    }

    const cnameDomain = this.getConfig("domainName");
    this.serverless.cli.consoleLog(chalk.yellow("CloudFront domain name"));
    this.serverless.cli.consoleLog(
      `  ${apiDistributionDomain.OutputValue} (CNAME: ${cnameDomain || "-"})`
    );

    if (cnameDomain) {
      this.serverless.cli.consoleLog(
        `AppSync: ${chalk.yellow(
          `Creating Route53 records for ${cnameDomain}...`
        )}`
      );

      await this.changeResourceRecordSet(
        "UPSERT",
        apiDistributionDomain.OutputValue
      );
    }
  }

  /**
   * Gets Certificate ARN that most closely matches domain name OR given Cert ARN if provided
   */
  async getCertArn() {
    let certificateArn; // The arn of the choosen certificate
    let certificateName = this.getConfig("certificateName");
    if (!certificateName && !this.getConfig("domainName")) return;
    try {
      const certData = await this.acm
        .listCertificates({ CertificateStatuses: certStatuses })
        .promise();

      // The more specific name will be the longest
      let nameLength = 0;
      const certificates = certData.CertificateSummaryList;

      // Checks if a certificate name is given
      if (certificateName != null) {
        const foundCertificate = certificates.find(
          (certificate) => certificate.DomainName === certificateName
        );
        if (foundCertificate != null) {
          certificateArn = foundCertificate.CertificateArn;
        }
      } else {
        certificateName = this.getConfig("domainName");
        for (const certificate of certificates) {
          let certificateListName = certificate.DomainName;
          // Looks for wild card and takes it out when checking
          if (certificateListName[0] === "*") {
            certificateListName = certificateListName.substr(1);
          }

          // Lookup expiration because expired AWS certs sometimes have an ISSUED status
          let certDescription = await this.acm
            .describeCertificate({ CertificateArn: certificate.CertificateArn })
            .promise();
          let isCertExpired = (Date.now() > certDescription.Certificate.NotAfter);

          // Looks to see if the name in the list is within the given domain
          // Also checks if the name is more specific than previous ones
          if (
            !isCertExpired &&
            certificateName.includes(certificateListName) &&
            certificateListName.length > nameLength
          ) {
            nameLength = certificateListName.length;
            certificateArn = certificate.CertificateArn;
          }
        };
      }
    } catch (err) {
      throw Error(
        `Error: Could not list certificates in Certificate Manager.\n${err}`
      );
    }
    if (certificateArn == null) {
      throw Error(`Error: Could not find the certificate ${certificateName}.`);
    }
    return certificateArn;
  }

  /**
   * Change A Alias record through Route53 based on given action
   * @param action: String descriptor of change to be made. Valid actions are ['UPSERT', 'DELETE']
   * @param domain: DomainInfo object containing info about custom domain
   */
  async changeResourceRecordSet(action, domain) {
    if (action !== "UPSERT" && action !== "DELETE") {
      throw new Error(`Error: Invalid action "${action}" when changing Route53 Record.
                Action must be either UPSERT or DELETE.\n`);
    }

    const createRoute53Record = this.getConfig("createRoute53Record");
    if (createRoute53Record !== undefined && createRoute53Record === false) {
      this.serverless.cli.log("Skipping creation of Route53 record.");
      return;
    }
    // Set up parameters
    const route53HostedZoneId = await this.getRoute53HostedZoneId();
    const Changes = ["A", "AAAA"].map((Type) => ({
      Action: action,
      ResourceRecordSet: {
        AliasTarget: {
          DNSName: domain,
          EvaluateTargetHealth: false,
          HostedZoneId: "Z2FDTNDATAQYW2", // CloudFront HZID is always Z2FDTNDATAQYW2
        },
        Name: this.getConfig("domainName"),
        Type,
      },
    }));
    const params = {
      ChangeBatch: {
        Changes,
        Comment: "Record created by serverless-appsync-cloudfront",
      },
      HostedZoneId: route53HostedZoneId,
    };
    // Make API call
    try {
      await this.route53.changeResourceRecordSets(params).promise();
    } catch (err) {
      throw new Error(
        `Error: Failed to ${action} A Alias for ${this.getConfig(
          "domainName"
        )}\n`
      );
    }
  }

  /**
   * Gets Route53 HostedZoneId from user or from AWS
   */
  async getRoute53HostedZoneId() {
    if (this.serverless.service.custom.appSyncCloudFront.hostedZoneId) {
      this.serverless.cli.log(
        `Selected specific hostedZoneId ${this.serverless.service.custom.appSyncCloudFront.hostedZoneId}`
      );
      return this.serverless.service.custom.appSyncCloudFront.hostedZoneId;
    }

    const filterZone = this.hostedZonePrivate !== undefined;
    if (filterZone && this.hostedZonePrivate) {
      this.serverless.cli.log("Filtering to only private zones.");
    } else if (filterZone && !this.hostedZonePrivate) {
      this.serverless.cli.log("Filtering to only public zones.");
    }

    let hostedZoneData;
    const givenDomainName = this.getConfig("domainName", "");
    const givenDomainNameReverse = givenDomainName.split(".").reverse();

    try {
      hostedZoneData = await this.route53.listHostedZones({}).promise();
      const targetHostedZone = hostedZoneData.HostedZones.filter(
        (hostedZone) => {
          let hostedZoneName;
          if (hostedZone.Name.endsWith(".")) {
            hostedZoneName = hostedZone.Name.slice(0, -1);
          } else {
            hostedZoneName = hostedZone.Name;
          }
          if (
            !filterZone ||
            this.hostedZonePrivate === hostedZone.Config.PrivateZone
          ) {
            const hostedZoneNameReverse = hostedZoneName.split(".").reverse();

            if (
              givenDomainNameReverse.length === 1 ||
              givenDomainNameReverse.length >= hostedZoneNameReverse.length
            ) {
              for (let i = 0; i < hostedZoneNameReverse.length; i += 1) {
                if (givenDomainNameReverse[i] !== hostedZoneNameReverse[i]) {
                  return false;
                }
              }
              return true;
            }
          }
          return false;
        }
      )
        .sort((zone1, zone2) => zone2.Name.length - zone1.Name.length)
        .shift();

      if (targetHostedZone) {
        const hostedZoneId = targetHostedZone.Id;
        // Extracts the hostzone Id
        const startPos = hostedZoneId.indexOf("e/") + 2;
        const endPos = hostedZoneId.length;
        return hostedZoneId.substring(startPos, endPos);
      }
    } catch (err) {
      throw new Error(`Error: Unable to list hosted zones in Route53.\n${err}`);
    }
    throw new Error(
      `Error: Could not find hosted zone "${this.getConfig("domainName")}"`
    );
  }

  async prepareResources(resources) {
    const distributionConfig =
      resources.Resources.AppSyncApiDistribution.Properties.DistributionConfig;

    this.prepareLogging(distributionConfig);
    this.prepareDomain(distributionConfig);
    this.preparePriceClass(distributionConfig);
    this.prepareCookies(distributionConfig);
    this.prepareHeaders(distributionConfig);
    this.prepareQueryString(distributionConfig);
    this.prepareComment(distributionConfig);
    await this.prepareCertificate(distributionConfig);
    this.prepareWaf(distributionConfig);
    this.prepareCompress(distributionConfig);
    this.prepareMinimumProtocolVersion(distributionConfig);
  }

  prepareLogging(distributionConfig) {
    const loggingBucket = this.getConfig("logging.bucket");

    if (loggingBucket !== null) {
      distributionConfig.Logging.Bucket = loggingBucket;
      distributionConfig.Logging.Prefix = this.getConfig("logging.prefix", "");
    } else {
      delete distributionConfig.Logging;
    }
  }

  prepareDomain(distributionConfig) {
    const domain = this.getConfig("domainName");
    if (domain !== null) {
      distributionConfig.Aliases = Array.isArray(domain) ? domain : [domain];
    } else {
      delete distributionConfig.Aliases;
    }
  }

  preparePriceClass(distributionConfig) {
    const priceClass = this.getConfig("priceClass", "PriceClass_All");
    distributionConfig.PriceClass = priceClass;
  }

  // prepareOrigins(distributionConfig) {
  //   distributionConfig.Origins[0].OriginPath = `/${this.options.stage}`;
  // }

  prepareCookies(distributionConfig) {
    const forwardCookies = this.getConfig("cookies", "all");
    distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.Forward = Array.isArray(
      forwardCookies
    )
      ? "whitelist"
      : forwardCookies;
    if (Array.isArray(forwardCookies)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.WhitelistedNames = forwardCookies;
    }
  }

  prepareHeaders(distributionConfig) {
    const forwardHeaders = this.getConfig("headers", "none");

    if (Array.isArray(forwardHeaders)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = forwardHeaders;
    } else {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers =
        forwardHeaders === "none" ? [] : ["*"];
    }
  }

  prepareQueryString(distributionConfig) {
    const forwardQueryString = this.getConfig("querystring", "all");

    if (Array.isArray(forwardQueryString)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString = true;
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryStringCacheKeys = forwardQueryString;
    } else {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString =
        forwardQueryString === "all";
    }
  }

  prepareComment(distributionConfig) {
    const name = this.serverless.getProvider("aws").naming.getApiGatewayName();
    distributionConfig.Comment = `Serverless Managed ${name}`;
  }

  async prepareCertificate(distributionConfig) {
    const certificate =
      this.getConfig("certificate") || (await this.getCertArn());
    if (certificate) {
      distributionConfig.ViewerCertificate.AcmCertificateArn = certificate;
    } else {
      delete distributionConfig.ViewerCertificate.AcmCertificateArn;
      delete distributionConfig.ViewerCertificate.SslSupportMethod;
      distributionConfig.ViewerCertificate.CloudFrontDefaultCertificate = true;
    }
  }

  prepareWaf(distributionConfig) {
    const waf = this.getConfig("waf");

    if (waf !== null) {
      distributionConfig.WebACLId = waf;
    } else {
      delete distributionConfig.WebACLId;
    }
  }

  prepareCompress(distributionConfig) {
    distributionConfig.DefaultCacheBehavior.Compress =
      this.getConfig("compress", false) === true;
  }

  prepareMinimumProtocolVersion(distributionConfig) {
    const minimumProtocolVersion = this.getConfig(
      "minimumProtocolVersion",
      undefined
    );

    if (minimumProtocolVersion) {
      distributionConfig.ViewerCertificate.MinimumProtocolVersion = minimumProtocolVersion;
    }
  }

  getConfig(field, defaultValue = null) {
    return _.get(
      this.serverless,
      `service.custom.appSyncCloudFront.${field}`,
      defaultValue
    );
  }
}

module.exports = ServerlessAppSyncCloudFrontPlugin;
