# githubtos3
A Lambda bot that responds to GitHub pushes and deploys to S3.
v3.1.0

## Note:
  After cloning or pulling changes remember to run 'npm install' from the **layers/CommonModules/nodejs** directory.
  
## Configuration:
  Please see the full How-To hosted in S3 using this Lambda bot [here](https://githubtos3.kylemunz.com/).

## Credits:
  By no means did I come up with all of this by myself. I drew heavy inspiration (and code) from the links below::

  [Dynamic GitHub Actions with AWS Lambda](https://aws.amazon.com/blogs/compute/dynamic-github-actions-with-aws-lambda/)

  [JavaScript GitHub API for Node.JS](http://mikedeboer.github.io/node-github/)

  [S3 Static Website Hosting](http://docs.aws.amazon.com/gettingstarted/latest/swh/website-hosting-intro.html)
  
  The changes in V3.0.x which moved the trigger for this function from GitHub's
  SNS service to an API Gateway webhook drew heavy inspiration from the
  [Github Webhook Listener](https://serverless.com/examples/aws-node-github-webhook-listener/)
