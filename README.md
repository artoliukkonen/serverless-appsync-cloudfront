# serverless-appsync-cloudfront

[![serverless](http://public.serverless.com/badges/v3.svg)](http://www.serverless.com)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](https://raw.githubusercontent.com/artoliukkonen/serverless-appsync-cloudfront/master/LICENSE)

Automatically creates properly configured AWS CloudFront distribution that routes traffic
to AppSync.

This plugin is modified from [serverless-api-cloudfront](https://github.com/Droplr/serverless-api-cloudfront) plugin to support AppSync instead of API Gateway.

**:zap: Pros**

- Allows you to set-up custom domain for your AppSync
- Zero setup with [serverless-custom-domain](https://github.com/amplify-education/serverless-domain-manager) (but works even without it)
- [Web Application Firewall](https://aws.amazon.com/waf/) support - enable AWS WAF to protect your API from security threats

## Installation

Either point to this repository from your package.json or clone this repo to `.serverless_plugins` folder in your project.

TODO: pending NPM release

## Configuration

* All appSyncCloudFront configuration parameters are optional - e.g. don't provide ACM Certificate ARN to use default CloudFront certificate (which works only for default cloudfront.net domain).
* For Route53 & custom domain, install [serverless-custom-domain](https://github.com/amplify-education/serverless-domain-manager). This plugin automatically reads the configuration of that plugin and uses correct cert for CloudFront. If you don't use that plugin you need to manually setup Route53. 
* First deployment may be quite long (e.g. 10 min) as Serverless is waiting for
  CloudFormation to deploy CloudFront distribution.
* **No custom configuration required if using [serverless-custom-domain](https://github.com/amplify-education/serverless-domain-manager)**
```
# add in your serverless.yml

plugins:
  - serverless-appsync-cloudfront

custom:
  appSyncCloudFront: # Only if not using serverless-custom-domain
    domain: my-custom-domain.com
    certificate: arn:aws:acm:us-east-1:000000000000:certificate/00000000-1111-2222-3333-444444444444
    waf: 00000000-0000-0000-0000-000000000000
    compress: true
    logging:
      bucket: my-bucket.s3.amazonaws.com
      prefix: my-prefix
    cookies: none
    headers:
      - x-api-key
    querystring:
      - page
      - per_page
    priceClass: PriceClass_100
    minimumProtocolVersion: TLSv1
```

### Notes

* `domain` can be list, so if you want to add more domains, instead string you list multiple ones:

```
domain:
  - my-custom-domain.com
  - secondary-custom-domain.com
```

* `cookies` can be *all* (default), *none* or a list that lists the cookies to whitelist
```
cookies:
  - FirstCookieName
  - SecondCookieName
```

* [`headers`][headers-default-cache] can be *all*, *none* (default) or a list of headers ([see CloudFront custom behaviour][headers-list]):

```
headers: all
```

[headers-default-cache]: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-distribution-defaultcachebehavior.html#cfn-cloudfront-distribution-defaultcachebehavior-forwardedvalues
[headers-list]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#request-custom-headers-behavior

* `querystring` can be *all* (default), *none* or a list, in which case all querystring parameters are forwarded, but cache is based on the list:

```
querystring: all
```

* [`priceClass`][price-class] can be `PriceClass_All` (default), `PriceClass_100` or `PriceClass_200`:


```
priceClass: PriceClass_All
```

[price-class]: https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_GetDistributionConfig.html#cloudfront-GetDistributionConfig-response-PriceClass

* [`minimumProtocolVersion`][minimum-protocol-version] can be `TLSv1` (default), `TLSv1_2016`, `TLSv1.1_2016`, `TLSv1.2_2018` or `SSLv3`:


```
minimumProtocolVersion: TLSv1
```

[minimum-protocol-version]: https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_ViewerCertificate.html#cloudfront-Type-ViewerCertificate-MinimumProtocolVersion

### IAM Policy

In order to make this plugin work as expected a few additional IAM Policies might be needed on your AWS profile.

More specifically this plugin needs the following policies attached:

* `cloudfront:CreateDistribution`
* `cloudfront:GetDistribution`
* `cloudfront:UpdateDistribution`
* `cloudfront:DeleteDistribution`
* `cloudfront:TagResource`

You can read more about IAM profiles and policies in the [Serverless documentation](https://serverless.com/framework/docs/providers/aws/guide/credentials#creating-aws-access-keys).
