const path = require('path');
const _ = require('lodash');
const chalk = require('chalk');
const yaml = require('js-yaml');
const fs = require('fs');

const certStatuses = ['PENDING_VALIDATION', 'ISSUED', 'INACTIVE'];

class ServerlessAppSyncCloudFrontPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'before:deploy:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this),
      'aws:info:displayStackOutputs': this.printSummary.bind(this),
    };

    const credentials = this.serverless.providers.aws.getCredentials();
    const acmCredentials = Object.assign({}, credentials, { region: 'us-east-1' });
    this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);
  }

  async createDeploymentArtifacts() {
    const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;

    const filename = path.resolve(__dirname, 'resources.yml');
    const content = fs.readFileSync(filename, 'utf-8');
    const resources = yaml.safeLoad(content, {
      filename,
    });

    await this.prepareResources(resources);
    return _.merge(baseResources, resources);
  }

  printSummary() {
    const awsInfo = _.find(this.serverless.pluginManager.getPlugins(), (plugin) => {
      return plugin.constructor.name === 'AwsInfo';
    });

    if (!awsInfo || !awsInfo.gatheredData) {
      return;
    }

    const { outputs } = awsInfo.gatheredData;
    const apiDistributionDomain = _.find(outputs, (output) => {
      return output.OutputKey === 'AppSyncApiDistribution';
    });

    if (!apiDistributionDomain || !apiDistributionDomain.OutputValue) {
      return;
    }

    const cnameDomain = this.getConfig('domain', null)
      || _.get(this.serverless, 'service.custom.customDomain.domainName', null);

    this.serverless.cli.consoleLog(chalk.yellow('CloudFront domain name'));
    this.serverless.cli.consoleLog(`  ${apiDistributionDomain.OutputValue} (CNAME: ${cnameDomain || '-'})`);
  }

  /**
   * Gets Certificate ARN that most closely matches domain name OR given Cert ARN if provided
   */
  async getCertArn() {
    if (this.serverless.service.custom.customDomain.certificateArn) {
      this.serverless.cli.log(
        `Selected specific certificateArn ${this.serverless.service.custom.customDomain.certificateArn}`);
      return this.serverless.service.custom.customDomain.certificateArn;
    }

    let certificateArn; // The arn of the choosen certificate
    let { certificateName } = this.serverless.service.custom.customDomain; // The certificate name
    const { domainName } = this.serverless.service.custom.customDomain; // Domain name
    try {
      const certData = await this.acm.listCertificates(
        { CertificateStatuses: certStatuses },
      ).promise();

      // The more specific name will be the longest
      let nameLength = 0;
      const certificates = certData.CertificateSummaryList;

      // Checks if a certificate name is given
      if (certificateName != null) {
        const foundCertificate = certificates
          .find(certificate => (certificate.DomainName === certificateName));
        if (foundCertificate != null) {
          certificateArn = foundCertificate.CertificateArn;
        }
      } else {
        certificateName = domainName;
        certificates.forEach((certificate) => {
          let certificateListName = certificate.DomainName;
          // Looks for wild card and takes it out when checking
          if (certificateListName[0] === '*') {
            certificateListName = certificateListName.substr(1);
          }
          // Looks to see if the name in the list is within the given domain
          // Also checks if the name is more specific than previous ones
          if (certificateName.includes(certificateListName)
            && certificateListName.length > nameLength) {
            nameLength = certificateListName.length;
            certificateArn = certificate.CertificateArn;
          }
        });
      }
    } catch (err) {
      throw Error(`Error: Could not list certificates in Certificate Manager.\n${err}`);
    }
    if (certificateArn == null) {
      throw Error(`Error: Could not find the certificate ${certificateName}.`);
    }
    return certificateArn;
  }


  async prepareResources(resources) {
    const distributionConfig = resources.Resources.AppSyncApiDistribution.Properties.DistributionConfig;

    this.prepareLogging(distributionConfig);
    this.prepareDomain(distributionConfig);
    this.preparePriceClass(distributionConfig);
    // this.prepareOrigins(distributionConfig);
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
    const loggingBucket = this.getConfig('logging.bucket', null);

    if (loggingBucket !== null) {
      distributionConfig.Logging.Bucket = loggingBucket;
      distributionConfig.Logging.Prefix = this.getConfig('logging.prefix', '');
    } else {
      delete distributionConfig.Logging;
    }
  }

  prepareDomain(distributionConfig) {
    const domain = this.getConfig('domain', null)
      || _.get(this.serverless, 'service.custom.customDomain.domainName', null);

    if (domain !== null) {
      distributionConfig.Aliases = Array.isArray(domain) ? domain : [domain];
    } else {
      delete distributionConfig.Aliases;
    }
  }

  preparePriceClass(distributionConfig) {
    const priceClass = this.getConfig('priceClass', 'PriceClass_All');
    distributionConfig.PriceClass = priceClass;
  }

  // prepareOrigins(distributionConfig) {
  //   distributionConfig.Origins[0].OriginPath = `/${this.options.stage}`;
  // }

  prepareCookies(distributionConfig) {
    const forwardCookies = this.getConfig('cookies', 'all');
    distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.Forward = Array.isArray(forwardCookies) ? 'whitelist' : forwardCookies;
    if (Array.isArray(forwardCookies)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Cookies.WhitelistedNames = forwardCookies;
    }
  }

  prepareHeaders(distributionConfig) {
    const forwardHeaders = this.getConfig('headers', 'none');

    if (Array.isArray(forwardHeaders)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = forwardHeaders;
    } else {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = forwardHeaders === 'none' ? [] : ['*'];
    }
  }

  prepareQueryString(distributionConfig) {
    const forwardQueryString = this.getConfig('querystring', 'all');

    if (Array.isArray(forwardQueryString)) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString = true;
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryStringCacheKeys = forwardQueryString;
    } else {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.QueryString = forwardQueryString === 'all';
    }
  }

  prepareComment(distributionConfig) {
    const name = this.serverless.getProvider('aws').naming.getApiGatewayName();
    distributionConfig.Comment = `Serverless Managed ${name}`;
  }

  async prepareCertificate(distributionConfig) {
    const certificate = this.getConfig('certificate', null) || await this.getCertArn();

    if (certificate !== null) {
      distributionConfig.ViewerCertificate.AcmCertificateArn = certificate;
    } else {
      delete distributionConfig.ViewerCertificate;
    }
  }

  prepareWaf(distributionConfig) {
    const waf = this.getConfig('waf', null);

    if (waf !== null) {
      distributionConfig.WebACLId = waf;
    } else {
      delete distributionConfig.WebACLId;
    }
  }

  prepareCompress(distributionConfig) {
    distributionConfig.DefaultCacheBehavior.Compress = (this.getConfig('compress', false) === true);
  }

  prepareMinimumProtocolVersion(distributionConfig) {
    const minimumProtocolVersion = this.getConfig('minimumProtocolVersion', undefined);

    if (minimumProtocolVersion) {
      distributionConfig.ViewerCertificate.MinimumProtocolVersion = minimumProtocolVersion;
    }
  }

  getConfig(field, defaultValue) {
    return _.get(this.serverless, `service.custom.appSyncCloudFront.${field}`, defaultValue);
  }
}

module.exports = ServerlessAppSyncCloudFrontPlugin;
