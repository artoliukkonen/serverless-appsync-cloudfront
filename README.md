# fullstack-serverless

[![serverless](http://public.serverless.com/badges/v3.svg)](http://www.serverless.com)
[![npm version](https://badge.fury.io/js/fullstack-serverless.svg)](https://badge.fury.io/js/fullstack-serverless)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](https://raw.githubusercontent.com/Droplr/serverless-api-cloudfront/master/LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/fullstack-serverless.svg?style=flat)](https://www.npmjs.com/package/fullstack-serverless)

Automatically creates properly configured AWS CloudFront distribution that serves static web content from S3 and routes API traffic
to API Gateway.

**:zap: Pros**

- Allows you to set-up custom domain for your S3 hosted site and API Gateway
- Free SSL using AWS CertificateManager
- No CORS needed
- Enables CDN caching of resources - so you don't waste Lambda invocations or API Gateway traffic
  for serving static files (just set proper Cache-Control in API responses)
- Much more CloudWatch statistics of API usage (like bandwidth metrics)
- Real world [access log](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html) - out of the box, API Gateway currently does not provide any kind of real "apache-like" access logs for your invocations
- [Web Application Firewall](https://aws.amazon.com/waf/) support - enable AWS WAF to protect your API from security threats

## Getting started
**First** Install and configure.

#### Installation

```
$ npm install --save-dev fullstack-serverless
```

#### Configuration

* All apiCloudFront configuration parameters are optional - e.g. don't provide ACM Certificate ARN
  to use default CloudFront certificate (which works only for default cloudfront.net domain).
* This plugin **does not** set-up automatically Route53 for newly created CloudFront distribution.
  After creating CloudFront distribution, manually add Route53 ALIAS record pointing to your
  CloudFront domain name.
* First deployment may be quite long (e.g. 10 min) as Serverless is waiting for
  CloudFormation to deploy CloudFront distribution.


```yaml
# add to your serverless.yml

plugins:
  - fullstack-serverless

custom:
  fullstack:
    domain: my-custom-domain.com
    certificate: arn:aws:acm:us-east-1:...     # The ARN for the SSL cert to use form AWS CertificateManager
    bucketName: webapp-deploy                  # Unique name for the S3 bucket to host the client assets
    distributionFolder: client/dist            # Path to the client assets to be uploaded to S3
    indexDocument: index.html                  # The index document to use
    errorDocument: error.html                  # The error document to use
    singlePageApp: false                       # If true 403 errors will be rerouted (missing assets) to your root index document to support single page apps like React and Angular where the js framework handles routing
    apiPath: api                               # The path prefix for your API Gateway lambdas. The path for the lambda http event trigger needs to start with this too eg. api/myMethod 
    clientCommand: gulp dist                   # Command to generate the client assets. Defaults to doing nothing
    clientSrcPath: client                      # The path to where you want to run the clientCommand
    waf: 00000000-0000-0000-0000-000000000000  # ID of the Web Application Firewall. Defaults to not used
    logging:
      bucket: my-bucket.s3.amazonaws.com
      prefix: my-prefix
```


**Second**, Create a website folder in the root directory of your Serverless project. This is where your distribution-ready website should live. By default the plugin expects the files to live in a folder called `client/dist`. But this is configurable with the `distributionFolder` option (see the [Configuration Parameters](#configuration-parameters) below).

The plugin uploads the entire `distributionFolder` to S3 and configures the bucket to host the website and make it publicly available, also setting other options based the [Configuration Parameters](#configuration-parameters) specified in `serverless.yml`.

To test the plugin initially you can copy/run the following commands in the root directory of your Serverless project to get a quick sample website for deployment:

```bash
mkdir -p client/dist
touch client/dist/index.html
touch client/dist/error.html
echo "Go Serverless" >> client/dist/index.html
echo "error page" >> client/dist/error.html
```

**Third**, run the plugin (this can take several minutes the first time), and visit your new website!

```
serverless deploy [--no-delete-contents] [--no-generate-client]
```

The plugin should output the location of your newly deployed static site to the console.

**Note:** *See [Command-line Parameters](#command-line-parameters) for details on command above*

**WARNING:** The plugin will overwrite any data you have in the bucket name you set above if it already exists.

To just generate and deploy your client code:

```bash
serverless client deploy [--no-delete-contents] [--no-generate-client]
```

If later on you want to take down the website you can use:

```bash
serverless client remove
```

### Configuration Parameters

**bucketName**

_required_

```yaml
custom:
  fullstack:
    ...
    bucketName: [unique-s3-bucketname]
    ...
```

Use this parameter to specify a unique name for the S3 bucket that your files will be uploaded to.

---

**distributionFolder**

_optional_, default: `client/dist`

```yaml
custom:
  fullstack:
    ...
    distributionFolder: [path/to/files]
    ...
```

Use this parameter to specify the path that contains your website files to be uploaded. This path is relative to the path that your `serverless.yaml` configuration files resides in.

---

**apiPath**

_optional_, default: `api`

```yaml
custom:
  fullstack:
    ...
    apiPath: api
    ...
```

Use this parameter to specify the path prefix your API Gateway methods will be available through on your CloudFront distribution (custom domain)

* `apiPath` must be included in the path for the lambdas you want exposed through CloudFront (your custom domain). Not all your methods need to be exposed through CloudFront. For some things, esp. those that are not public facing (eg. third web hooks) you may want to use the ApiGateway URL and not expose them through CloudFront to control access and cost.

```yaml
functions:
  message:
    handler: message.handler
    timeout: 30
    events:
      - http:
        path: ${self:custom.fullstack.apiPath}/message
        method: post
        integration: lambda
```

---

**certificate**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    certificate: arn:aws:acm:us-east-1:...
    ...
```

Use this parameter to specify ARN for the SSL cert to use form AWS CertificateManager

---

**indexDocument**

_optional_, default: `index.html`

```yaml
custom:
  fullstack:
    ...
    indexDocument: [file-name.ext]
    ...
```

The name of your index document inside your `distributionFolder`. This is the file that will be served to a client visiting the base URL for your website.

---

**domain**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    domain: my-custom-domain.com
    ...
```

`domain` can be a list, if you want to add more domains:
```yaml
custom:
  fullstack:
    ...
    domain:
    - my-custom-domain.com
    - secondary-custom-domain.com
    ...
```

The custom domain for your fullstack serverless app.

---

**errorDocument**

_optional_, default: `error.html`

```yaml
custom:
  fullstack:
    ...
    errorDocument: [file-name.ext]
    ...
```

The name of your error document inside your `distributionFolder`. This is the file that will be served to a client if their initial request returns an error (e.g. 404). For an SPA, you may want to set this to the same document specified in `indexDocument` so that all requests are redirected to your index document and routing can be handled on the client side by your SPA.

---

**singlePageApp**

_optional_, default: `false`

```yaml
custom:
  fullstack:
    ...
    singlePageApp: true
    ...
```

If true 403 errors will be rerouted (missing assets) to your root index document to support single page apps like React and Angular where the js framework handles routing
    
---

**clientCommand**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    clientCommand: [command to generate your client (e.g. gulp dist)]
    ...
```

Command to generate the client assets. Defaults to doing nothing
       
---

**clientSrcPath**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    clientSrcPath: [path/to/your/client]
    ...
```

The path to where you want to run the `clientCommand`    
       
---

**waf**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    waf: [web application firewall ARN]
    ...
```

[Web Application Firewall](https://aws.amazon.com/waf/) support - enable AWS WAF to protect your API from security threats
         
---

**logging**

_optional_, default: `not set`

```yaml
custom:
  fullstack:
    ...
    logging:
      bucket: my-bucket.s3.amazonaws.com
      prefix: my-prefix
    ...
```

Real world [access log](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html) - out of the box, API Gateway currently does not provide any kind of real "apache-like" access logs for your invocations
         
---

### Command-line Parameters


**--no-delete-contents**

_optional_, default `false` (deletes contents by default)

```bash
serverless client deploy --no-delete-contents
```

Use this parameter if you do not want to delete the contents of your bucket before deployment. Files uploaded during deployment will still replace any corresponding files already in your bucket.

---

**--no-generate-client**

_optional_, default `false` (generates client code by default if `clientCommand` and `clientSrcPath` are configured)

```bash
serverless client deploy --no-generate-client
```

Use this parameter if you do not want to delete the contents of your bucket before deployment. Files uploaded during deployment will still replace any corresponding files already in your bucket.

---

**--no-confirm**

_optional_, default `false` (disables confirmation prompt)

```bash
serverless client deploy --no-confirm
```

Use this parameter if you do not want a confirmation prompt to interrupt automated builds.

---

## Maintainers
- Andy Hahn - [andrewphahn](https://github.com/andrewphahn)

## Contributors
- [redroot](https://github.com/redroot)
- [amsross](https://github.com/amsross)
- [pradel](https://github.com/pradel)
- [daguix](https://github.com/daguix)
- [shentonfreude](https://github.com/shentonfreude)
- [evanseeds](https://github.com/evanseeds)
- [wzedi](https://github.com/wzedi)

Forked from the [**serverless-api-cloudfront**](https://github.com/Droplr/serverless-api-cloudfront/)  
Borrowed heavily from the [**serverless-finch**](https://github.com/fernando-mc/serverless-finch/)  
Initial CloudFormation template from [**Full Stack Serverless Web Apps with AWS**](https://medium.com/99xtechnology/full-stack-serverless-web-apps-with-aws-189d87da024a/)