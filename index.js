const path = require('path');
const _ = require('lodash');
const chalk = require('chalk');
const yaml = require('js-yaml');
const fs = require('fs');

class ServerlessApiCloudFrontPlugin {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;

        this.hooks = {
            'package:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this),
            'aws:info:displayStackOutputs': this.printSummary.bind(this),
        };
    }

    createDeploymentArtifacts() {
        const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;

        const filename = path.resolve(__dirname, 'resources.yml');
        const content = fs.readFileSync(filename, 'utf-8');
        const resources = yaml.safeLoad(content, {
            filename: filename
        });

        this.prepareResources(resources);
        return _.merge(baseResources, resources);
    }

    printSummary() {
        const cloudTemplate = this.serverless;

        const awsInfo = _.find(this.serverless.pluginManager.getPlugins(), (plugin) => {
            return plugin.constructor.name === 'AwsInfo';
        });

        if (!awsInfo || !awsInfo.gatheredData) {
            return;
        }

        const outputs = awsInfo.gatheredData.outputs;
        const apiDistributionDomain = _.find(outputs, (output) => {
            return output.OutputKey === 'ApiDistribution';
        });

        if (!apiDistributionDomain || !apiDistributionDomain.OutputValue) {
            return;
        }

        const cnameDomain = this.getConfig('domain', '-');

        this.serverless.cli.consoleLog(chalk.yellow('CloudFront domain name'));
        this.serverless.cli.consoleLog(`  ${apiDistributionDomain.OutputValue} (CNAME: ${cnameDomain})`);
    }

    prepareResources(resources) {
        const distributionConfig = resources.Resources.ApiDistribution.Properties.DistributionConfig;

        this.prepareLogging(distributionConfig);
        this.prepareDomain(distributionConfig);
        this.preparePriceClass(distributionConfig);
        this.prepareOrigins(distributionConfig);
        this.preparePathPattern(distributionConfig);
        this.prepareComment(distributionConfig);
        this.prepareCertificate(distributionConfig);
        this.prepareWaf(distributionConfig);
        this.prepareSinglePageApp(distributionConfig);
        this.prepareS3(resources.Resources);
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
        const domain = this.getConfig('domain', null);

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

    prepareOrigins(distributionConfig) {
        for (var origin of distributionConfig.Origins) {
            if (origin.Id === 'ApiGateway') {
                origin.OriginPath = `/${this.getStage()}`;
            }
        }
    }

    preparePathPattern(distributionConfig) {
        const apiPath = this.getConfig('apiPath', 'api');
        for (let cacheBehavior of distributionConfig.CacheBehaviors) {
            if (cacheBehavior.TargetOriginId === 'ApiGateway') {
                cacheBehavior.PathPattern = `${apiPath}/*`;
            }
        }
    }

    prepareComment(distributionConfig) {
        const name = this.serverless.getProvider('aws').naming.getApiGatewayName();
        distributionConfig.Comment = `Serverless Managed ${name}`;
    }

    prepareCertificate(distributionConfig) {
        const certificate = this.getConfig('certificate', null);

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

    prepareSinglePageApp(distributionConfig) {
        const isSinglePageApp = this.getConfig('singlePageApp', false);
        if (isSinglePageApp) {
            const indexDocument = this.getConfig('indexDocument', 'index.html')
            for (let errorResponse of distributionConfig.CustomErrorResponses) {
                if (errorResponse.ErrorCode === '403') {
                    errorResponse.ResponsePagePath = `/${indexDocument}`
                }
            }
        } else {
            delete distributionConfig.CustomErrorResponses;
        }
    }

    prepareS3(resources) {
        const bucketName = this.getConfig('bucketName', null);

        if (bucketName !== null) {
            const stageBucketName = `${this.serverless.service.service}-${this.getStage()}-${bucketName}`;
            resources.WebAppS3Bucket.Properties.BucketName = stageBucketName;
            resources.WebAppS3BucketPolicy.Properties.Bucket = stageBucketName;
        }
    }

    getConfig(field, defaultValue) {
        return _.get(this.serverless, `service.custom.apiCloudFront.${field}`, defaultValue)
    }

    getStage() {
        // find the correct stage name
        var stage = this.serverless.service.provider.stage;
        if (this.serverless.variables.options.stage) {
            stage = this.serverless.variables.options.stage;
        }
        return stage;
    }
}

module.exports = ServerlessApiCloudFrontPlugin;
