// ******
// Configuring Services on GitHub can be...unecessarily difficult.
// With webhooks you will find an array of check boxes to choose which events
// will trigger an action. With services only the 'push' event is enabled by
// default and you will not find any convenient check boxes to enable others.
// GitHubtoS3 only requires the default 'push' event to be triggered, however
// I have provided this information here incase you decide to expand its functionality.
// For services the enabling/disabling of events for services can only be done
// through API calls. You can do it with the following curl commands::
//
// (Replace USERORORG with the GitHUb user or Organization the repo belongs to)
// (Replace REPONAME with the name of the repository)
//
// List existing hooks: (Use this to find the ID of the hook to modify)
// curl -u USERNAME -i https://api.github.com/repos/USERORORG/REPONAME/hooks
//
// (Replace ID with the hook ID retrieved in the above command)
//
// Remove events from specific hook:
// curl -u USERNAME -i https://api.github.com/repos/USERORORG/REPONAME/hooks/ID --request PATCH --data "{\"remove_events\": [\"push\"]}"
//
// Add events to a specific hook:
// curl -u USERNAME -i https://api.github.com/repos/USERORORG/REPONAME/hooks/ID --request PATCH --data "{\"add_events\": [\"push\"]}"
//
//
//
// ******
// Optionally you can create the entire hook from scratch using this script.
// Provide your GitHub and AWS information to the variables below, then from within terminal run:
// node /path/to/createHook.js

// Configuration variables
var githubUser = '';   // Owner of the GitHub repo to be deployed
var githubRepo = ''; // Name of the GitHub repo to be deployed
var awsIAMKey = ''; //AWS Key of IAM Publisher account
var awsIAMSecret = '';  //AWS secretAccessKey of IAM Publisher account
var awsSNSTopic = '';  //SNS Topic ARN
var awsSNSRegion = ''; // AWS Region where your SNS topic resides
// *****

var GitHubApi = require('github');
var github = new GitHubApi({
  version: '3.0.0'
});
var github_token = require('./github_token_km.json');
github.authenticate(github_token);

function createSNSHook(user, repo, key, topic, region, secret) {
  apiMsg = {
    user: user,
    repo: repo,
    name: 'amazonsns',
    config: {
      "aws_key": key,
      "sns_topic": topic,
      "sns_region": region,
      "aws_secret": secret
    },
    events: [
      "push",
      "issues"
    ],
    active: true
  };

  github.repos.createHook( apiMsg, function(err, data) {
    if(err) {
      console.log("createHook failed:: "+err);
    } else {
      var dataContent = JSON.stringify(data, null, 2);
      console.log("Service 'amazonsns' created:: "+dataContent);
    }
  });
};

//console.log(githubUser && githubRepo && awsIAMKey && awsIAMSecret && awsSNSTopic && awsSNSRegion.length);
//console.log(githubUser.length);


if(githubUser && githubRepo && awsIAMKey && awsIAMSecret && awsSNSTopic && awsSNSRegion) {
  createSNSHook(githubUser, githubRepo, awsIAMKey, awsSNSTopic, awsSNSRegion, awsIAMSecret);
} else {
  console.log("Error:: All configuration variables are required.");
}
