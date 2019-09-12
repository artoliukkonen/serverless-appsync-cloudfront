const aws = require('aws-sdk');

const getCloudFrontDomain = (serverless) => {
    const awsInfoPlugin = serverless.pluginManager.getPlugins()
        .find(plugin => plugin.constructor.name === 'AwsInfo');

    if (!awsInfoPlugin || !awsInfoPlugin.gatheredData) {
        return null;
    }

    const outputs = awsInfoPlugin.gatheredData.outputs,
        distributionDomain = outputs.find(output => output.OutputKey === 'ApiDistribution');

    if (!distributionDomain || !distributionDomain.OutputValue) {
        return null;
    }

    return distributionDomain.OutputValue;
};

const getCloudFrontClient = (credentials, region) => {
    return new aws.CloudFront({
        credentials,
        region
    })
};

const getCloudFrontDistributionByDomain = async (cloudFrontClient, domain) => {
    const listResponse = await cloudFrontClient.listDistributions({}).promise();

    return listResponse.DistributionList.Items
        .find(
            (distribution) => distribution.DomainName === domain
        );
};

const invalidateCloudfrontDistribution = async (serverless, region) => {
    const credentials = serverless.getProvider('aws').getCredentials().credentials,
        cloudFrontClient = getCloudFrontClient(credentials, region),
        domain = getCloudFrontDomain(serverless);

    if (!domain) {
        return;
    }

    const distribution = await getCloudFrontDistributionByDomain(cloudFrontClient, domain),
        invalidationParams = {
            DistributionId: distribution.Id,
            InvalidationBatch: {
                CallerReference: String(Date.now()),
                Paths: {
                    Quantity: 1,
                    Items: ['/*']
                }
            }
        };

    await cloudFrontClient.createInvalidation(invalidationParams).promise()
};

module.exports = {
    getCloudFrontDomain,
    invalidateCloudfrontDistribution
};
