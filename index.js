const path = require('path');
const _ = require('lodash');
const chalk = require('chalk');
const yaml = require('js-yaml');
const fs = require('fs');
const {spawn} = require('child_process');

const BbPromise = require('bluebird');
const Confirm = require('prompt-confirm');

const bucketUtils = require('./lib/bucketUtils');
const uploadDirectory = require('./lib/upload');
const validateClient = require('./lib/validate');

class ServerlessFullstackPlugin {
    constructor(serverless, cliOptions) {

        this.error = serverless.classes.Error;
        this.serverless = serverless;
        this.options = serverless.service.custom.fullstack;
        this.cliOptions = cliOptions || {};
        this.aws = this.serverless.getProvider('aws');

        this.hooks = {
            'package:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this),
            'aws:info:displayStackOutputs': this.printSummary.bind(this),
            'client:client': () => this.serverless.cli.log(this.commands.client.usage),
            'before:client:deploy:deploy': this.generateClient.bind(this),
            'client:deploy:deploy': this.processDeployment.bind(this),
            'client:remove:remove': this.removeDeployedResources.bind(this),
            'after:aws:deploy:deploy:updateStack': () => this.serverless.pluginManager.run(['client', 'deploy']),
            'before:remove:remove': () => this.serverless.pluginManager.run(['client', 'remove'])
        };

        this.commands = {
            client: {
                usage: 'Generate and deploy clients',
                lifecycleEvents: ['client', 'deploy'],
                commands: {
                    deploy: {
                        usage: 'Deploy serverless client code',
                        lifecycleEvents: ['deploy']
                    },
                    remove: {
                        usage: 'Removes deployed files and bucket',
                        lifecycleEvents: ['remove']
                    }
                }
            }
        };
    }

    validateConfig() {
        try {
            validateClient(this.serverless, this.options);
        } catch (e) {
            return BbPromise.reject(`Fullstack serverless configuration errors:\n- ${e.join('\n- ')}`);
        }
        return BbPromise.resolve();
    }

    removeDeployedResources() {
        let bucketName;

        return this.validateConfig()
            .then(() => {
                bucketName = this.getBucketName(this.options.bucketName);
                return this.cliOptions.confirm === false ? true : new Confirm(`Are you sure you want to delete bucket '${bucketName}'?`).run();
            })
            .then(goOn => {
                if (goOn) {
                    this.serverless.cli.log(`Looking for bucket '${bucketName}'...`);
                    return bucketUtils.bucketExists(this.aws, bucketName).then(exists => {
                        if (exists) {
                            this.serverless.cli.log(`Deleting all objects from bucket...`);
                            return bucketUtils
                                .emptyBucket(this.aws, bucketName)
                                .then(() => {
                                    this.serverless.cli.log(
                                        `Success! Your client files have been removed`
                                    );
                                });
                        } else {
                            this.serverless.cli.log(`Bucket does not exist`);
                        }
                    });
                }
                this.serverless.cli.log('Bucket not removed');
                return BbPromise.resolve();
            })
            .catch(error => {
                return BbPromise.reject(new this.error(error));
            });
    }

    generateClient() {

        const clientCommand = this.options.clientCommand;
        const clientSrcPath = this.options.clientSrcPath || '.';
        if (clientCommand && this.cliOptions['generate-client'] !== false) {
            const args = clientCommand.split(' ');
            const command = args.shift();
            return new BbPromise(this.performClientGeneration.bind(this, command, args, clientSrcPath));

        } else {
            this.serverless.cli.log(`Skipping client generation...`);
        }

        return BbPromise.resolve();
    }

    performClientGeneration(command, args, clientSrcPath, resolve, reject) {
        this.serverless.cli.log(`Generating client...`);
        const proc = spawn(command, args, {cwd: clientSrcPath, env: process.env});

        proc.stdout.on('data', (data) => {
            const printableData = data ? `${data}`.trim() : '';
            this.serverless.cli.consoleLog(`   ${chalk.dim(printableData)}`);
        });

        proc.stderr.on('data', (data) => {
            const printableData = data ? `${data}`.trim() : '';
            this.serverless.cli.consoleLog(`   ${chalk.red(printableData)}`);
        });

        proc.on('close', (code) => {
            if (code === 0) {
                this.serverless.cli.log(`Client generation process succeeded...`);
                resolve();
            } else {
                reject(new this.error(`Client generation failed with code ${code}`));
            }
        });
    }

    processDeployment() {
        let region,
            distributionFolder,
            clientPath,
            bucketName,
            headerSpec,
            indexDoc,
            errorDoc;

        return this.validateConfig()
            .then(() => {
                // region is set based on the following order of precedence:
                // If specified, the CLI option is used
                // If region is not specified via the CLI, we use the region option specified
                //   under custom/client in serverless.yml
                // Otherwise, use the Serverless region specified under provider in serverless.yml
                region =
                    this.cliOptions.region ||
                    this.options.region ||
                    _.get(this.serverless, 'service.provider.region');

                distributionFolder = this.options.distributionFolder || path.join('client/dist');
                clientPath = path.join(this.serverless.config.servicePath, distributionFolder);
                bucketName = this.getBucketName(this.options.bucketName);
                headerSpec = this.options.objectHeaders;
                indexDoc = this.options.indexDocument || "index.html";
                errorDoc = this.options.errorDocument || "error.html";

                const deployDescribe = ['This deployment will:'];

                if (this.cliOptions['delete-contents'] !== false) {
                    deployDescribe.push(`- Remove all existing files from bucket '${bucketName}'`);
                }
                deployDescribe.push(
                    `- Upload all files from '${distributionFolder}' to bucket '${bucketName}'`
                );

                deployDescribe.forEach(m => this.serverless.cli.log(m));
                return this.cliOptions.confirm === false ? true : new Confirm(`Do you want to proceed?`).run();
            })
            .then(goOn => {
                if (goOn) {
                    this.serverless.cli.log(`Looking for bucket '${bucketName}'...`);
                    return bucketUtils
                        .bucketExists(this.aws, bucketName)
                        .then(exists => {
                            if (exists) {
                                this.serverless.cli.log(`Bucket found...`);
                                if (this.cliOptions['delete-contents'] === false) {
                                    this.serverless.cli.log(`Keeping current bucket contents...`);
                                    return BbPromise.resolve();
                                }

                                this.serverless.cli.log(`Deleting all objects from bucket...`);
                                return bucketUtils.emptyBucket(this.aws, bucketName);
                            } else {
                                this.serverless.cli.log(`Bucket does not exist. Run ${chalk.black('serverless deploy')}`);
                                return BbPromise.reject('Bucket does not exist!');
                            }
                        })
                        .then(() => {
                            this.serverless.cli.log(`Uploading client files to bucket...`);
                            return uploadDirectory(this.aws, bucketName, clientPath, headerSpec);
                        })
                        .then(() => {
                            this.serverless.cli.log(
                                `Success! Client deployed.`
                            );
                        });
                }
                this.serverless.cli.log('Client deployment cancelled');
                return BbPromise.resolve();
            })
            .catch(error => {
                return BbPromise.reject(new this.error(error));
            });
    }

    createDeploymentArtifacts() {
        const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;

        const filename = path.resolve(__dirname, 'lib/resources/resources.yml');
        const content = fs.readFileSync(filename, 'utf-8');
        const resources = yaml.safeLoad(content, {
            filename: filename
        });

        this.prepareResources(resources);
        return _.merge(baseResources, resources);
    }

    printSummary() {
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
            this.serverless.cli.log(`Setting up logging bucket...`);
            distributionConfig.Logging.Bucket = loggingBucket;
            distributionConfig.Logging.Prefix = this.getConfig('logging.prefix', '');

        } else {
            this.serverless.cli.log(`Removing logging bucket...`);
            delete distributionConfig.Logging;
        }
    }

    prepareDomain(distributionConfig) {
        const domain = this.getConfig('domain', null);

        if (domain !== null) {
            this.serverless.cli.log(`Adding domain alias ${domain}...`);
            distributionConfig.Aliases = Array.isArray(domain) ? domain : [domain];
        } else {
            delete distributionConfig.Aliases;
        }
    }

    preparePriceClass(distributionConfig) {
        const priceClass = this.getConfig('priceClass', 'PriceClass_All');
        this.serverless.cli.log(`Setting price class ${priceClass}...`);
        distributionConfig.PriceClass = priceClass;
    }

    prepareOrigins(distributionConfig) {
        this.serverless.cli.log(`Setting ApiGateway stage to '${this.getStage()}'...`);
        for (var origin of distributionConfig.Origins) {
            if (origin.Id === 'ApiGateway') {
                origin.OriginPath = `/${this.getStage()}`;
            }
        }
    }

    preparePathPattern(distributionConfig) {
        const apiPath = this.getConfig('apiPath', 'api');
        this.serverless.cli.log(`Setting API path prefix to '${apiPath}'...`);
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
            this.serverless.cli.log(`Configuring SSL certificate...`);
            distributionConfig.ViewerCertificate.AcmCertificateArn = certificate;
        } else {
            delete distributionConfig.ViewerCertificate;
        }
    }

    prepareWaf(distributionConfig) {
        const waf = this.getConfig('waf', null);

        if (waf !== null) {
            this.serverless.cli.log(`Enabling web application firewall...`);
            distributionConfig.WebACLId = waf;
        } else {
            delete distributionConfig.WebACLId;
        }
    }

    prepareSinglePageApp(distributionConfig) {
        const isSinglePageApp = this.getConfig('singlePageApp', false);
        if (isSinglePageApp) {
            this.serverless.cli.log(`Configuring distrobution for single page web app...`);
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
            const stageBucketName = this.getBucketName(bucketName);
            this.serverless.cli.log(`Setting up '${stageBucketName}' bucket...`);
            resources.WebAppS3Bucket.Properties.BucketName = stageBucketName;
            resources.WebAppS3BucketPolicy.Properties.Bucket = stageBucketName;
        } else {
            this.serverless.cli.log(`Setting up '${resources.WebAppS3Bucket.Properties.BucketName}' bucket...`);
        }

        const indexDocument = this.getConfig('indexDocument', 'index.html');
        const errorDocument = this.getConfig('errorDocument', 'error.html');

        this.serverless.cli.log(`Setting indexDocument to '${indexDocument}'...`);
        this.serverless.cli.log(`Setting errorDocument to '${errorDocument}'...`);

        resources.WebAppS3Bucket.Properties.WebsiteConfiguration.IndexDocument = indexDocument;
        resources.WebAppS3Bucket.Properties.WebsiteConfiguration.ErrorDocument = errorDocument;
    }

    getBucketName(bucketName) {
        const stageBucketName = `${this.serverless.service.service}-${this.getStage()}-${bucketName}`;
        return stageBucketName;
    }

    getConfig(field, defaultValue) {
        return _.get(this.serverless, `service.custom.fullstack.${field}`, defaultValue)
    }

    getStage() {
        // find the correct stage name
        var stage = this.serverless.service.provider.stage;
        if (this.serverless.variables.cliOptions && this.serverless.variables.cliOptions.stage) {
            stage = this.serverless.variables.cliOptions.stage;
        }
        return stage;
    }
}

module.exports = ServerlessFullstackPlugin;
