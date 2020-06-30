'use strict';
console.log('Loading function: Version 3.1.0');

//
// add/configure modules
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const AWS = require('aws-sdk');
const SNS = new AWS.SNS();

//
// Sign the request body
function signRequestBody(key, body) {
  return `sha1=${crypto.createHmac('sha1', key).update(body, 'utf-8').digest('hex')}`;
} // End signRequestBody

//
// getDeployJSON
// Retrieve the deploy.json from GitHub for this repo/branch
// Parameters:
// {
//  pat: GITHUB_PERSONAL_ACCESS_TOKEN,
//  owner: Owner name for this GitHub repository
//  repo: Repository name
//  ref: 'refs/heads/master' or 'refs/heads/dev' *(OPTIONAL) Defaults to master
//  }
function getDeployJSON(params) {
  return new Promise( (resolve, reject) => {
    if(!params.pat || !params.owner || !params.repo) {
      console.log(`getDeployJSON: PAT: ${params.pat} Owner:${params.owner} Repo:${params.repo}`);  // DEBUG:
      return reject("getDeployJSON(): PAT, Owner, and Repo are required fields.");
    } else {

      // Create authorized github client (auth allows access to private repos)
      const octokit = new Octokit({
        auth: params.pat
      });

      var gCparams = {
        owner: params.owner,
        repo: params.repo,
        path: 'deploy.json'
      };
      // If ref not provided default to master
      gCparams.ref = (params.ref=='refs/heads/dev') ? params.ref : 'refs/heads/master';
      octokit.repos.getContent(gCparams)
      .then(result => {
        // content will be base64 encoded
        var content = Buffer.from(result.data.content, 'base64').toString();
        console.log(`getDeployJSON:content: ${content}`);
        validateDeployJSON(JSON.parse(content))
        .then(() => {
          console.log("getDeployJSON:validateDeployJSON: checks out."); // DEBUG:
          return resolve(JSON.parse(content));
        })
        .catch(() => {
          console.log("getDeployJSON:validateDeployJSON: invalid format."); // DEBUG:
          return reject("Invalid deploy.json format.");
        });
      })
      .catch((err) => {
        console.log("getDeployJSON:octokit.repos.getContents Error: ", err); // DEBUG:
        return reject("getDeployJSON:octokit.repos.getContents Error.");
      });
    }
  }); // End Promise
} // End getDeployJSON

//
// validateDeployJSON
// Sanity check on the supplied deploy.json
function validateDeployJSON(deployObject) {
  return new Promise( (resolve, reject) => {
    if(deployObject === null || typeof deployObject !== 'object') {
      console.log("validateDeployJSON: no deployObject"); // DEBUG:
      return reject("validateDeployJSON(): deployObject is a required argument and must be an object");
    } else {
      if(
        deployObject.hasOwnProperty('deploy')
        && deployObject.deploy.hasOwnProperty('type')
        && deployObject.deploy.hasOwnProperty('target')
        && deployObject.deploy.target.hasOwnProperty('master')
        && deployObject.deploy.target.hasOwnProperty('dev')
      ) {
        return resolve();
      } else {
        return reject();
      }
    }
  }); // End Promise
} // End validateDeployJSON

//
// publishToSns
// Publish the GitHub push event to SNS to trigger the deployer
// Parameters:
// data - the data to publish, duh
// region - the AWS region of the SNS topic to publish to
// acctId - the AWS account Id of the SNS topic to publish to
function publishToSns(params) {
  return new Promise( (resolve,reject) => {
    if(!params.data || !params.region || !params.acctId) {
      console.log(`publishToSns: Region: ${params.region} AcctId:${params.acctId} Data:${params.data}`);  // DEBUG:
      return reject("publishToSns(): Data, Region, and AcctId are required fields.");
    } else {
      const pubParams = {
        Message: JSON.stringify(params.data),
        TopicArn: `arn:aws:sns:${params.region}:${params.acctId}:github-webhooks`
      };
      console.log("pubParams: "+JSON.stringify(pubParams,null,2));  // DEBUG:
      SNS.publish(pubParams).promise()
      .then(response => {
        console.log("publishToSns:SNS.publish response: "+JSON.stringify(response,null,2)); // DEBUG:
        return resolve(response);
      })
      .catch((err) => {
        console.log(`publishToSns: Region: ${params.region} AcctId:${params.acctId} Data:${params.data}`);  // DEBUG:
        console.log("publishToSns:SNS.publish Error: ", err); // DEBUG:
        return reject("publishToSns:SNS.publish Error.");
      });
    }
  }); // End Promise
} // end publishToSns

//
// genResObj200
// Generates the http 200 response code to feed back through APIG
function genResObj200(message) {
  return new Promise( (resolve,reject) => {
    // Default McConaughey response
    message = (message===null) ? 'Alright, alright, alright.' : message;
    var res200 = {
      statusCode: '200',
      body: JSON.stringify({"response": message}),
      headers: {
        'Content-Type': 'application/json',
      }
    };
    return resolve(res200);
  }); // End Promise
} // End genResObj200

//
// genResObj400
// Generates the http 400 response code to feed back through APIG
function genResObj400(message) {
  return new Promise( (resolve,reject) => {
    // Default Negative response
    message = (message===null) ? "That's a negative Ghost rider, the pattern is full." : message;
    var res400 = {
      statusCode: '400',
      body: JSON.stringify({"response": message}),
      headers: {
        'Content-Type': 'application/json'
      }
    };
    return resolve(res400);
  }); // End Promise
} // End genResObj400

//
// handleError
// Writes error message to DDB errorTable for reporting
function handleError(method, message, context) {
  return new Promise( (resolve) => {
    var errorMessage = {
      lambdaFunctionName: context.functionName,
      eventTimeUTC: new Date().toUTCString(),
      methodName: method,
      error: message
    };  // End errorMessage
    console.log("handleError: "+JSON.stringify(errorMessage));  // DEBUG:

    var params = {
      TableName: 'errorLogs',
      Item: {
        // DDB ttl to expire item after 1 month
        ttl: Math.floor(Date.now() / 1000) + 2592000,
        data: errorMessage
      }
    };  // End params

    // Load the DDB client and write the errorLogs
    // Now everybody gonna know what you did.
    new AWS.DynamoDB.DocumentClient({region: 'us-east-1'}).put(params, function(err, data) {
      if (err) console.log("Unable to add DDB item to errorLogs: "+JSON.stringify(err, null, 2));
      return resolve();
    }); // End DDB.put
  }); // End Promise
} // End handleError

// ****************************************************
// ****************************************************
//
// Main function begins here
module.exports.handler = async (event, context, callback) => {
  console.log('Received event:', JSON.stringify(event, null, 2)); // DEBUG

  // GitHub event is contained in event.body as a stringified JSON, so parse it.
  const githubEventObject = JSON.parse(event.body);
  console.log('githubEventObject: ', JSON.stringify(githubEventObject, null, 2)); // DEBUG: yeah I parsed it just to stringify it

  // Check if a github personal access token has been set as an environment variable.
  // Without this we can't retrieve private repos, this is fatal.
  if(!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.log("process.env.GITHUB_PERSONAL_ACCESS_TOKEN missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_PERSONAL_ACCESS_TOKEN)","Missing GITHUB_PERSONAL_ACCESS_TOKEN.",context);
    return callback(null, await genResObj400("Missing process.env.GITHUB_PERSONAL_ACCESS_TOKEN."));
  }

  // Check if a github webhook secret token has been set as an environment variable.
  // Without this we can't compare the event signature sent by GitHub
  if(!process.env.GITHUB_WEBHOOK_SECRET) {
    console.log("process.env.GITHUB_WEBHOOK_SECRET missing"); // DEBUG:
    await handleError("if(process.env.GITHUB_WEBHOOK_SECRET)","Missing GITHUB_WEBHOOK_SECRET",context);
    return callback(null, await genResObj400("Missing process.env.GITHUB_WEBHOOK_SECRET."));
  }

  // Check if event has X-Hub-Signature header
  // Without this we can't verify GitHub actually sent this event, IT COULD BE ANYBODY ZOMBGOSH!!!!
  if(!event.headers.hasOwnProperty('X-Hub-Signature')) {
    console.log("No X-Hub-Signature found on request"); // DEBUG:
    await handleError("if(X-Hub-Signature)","Missing X-Hub-Signature header.",context);
    return callback(null, await genResObj400("No X-Hub-Signature found on request."));
  }

  // Check if the event signatures match
  // If they don't match then somebody other than GitHub sent this event.
  if(event.headers['X-Hub-Signature'] !== signRequestBody(process.env.GITHUB_WEBHOOK_SECRET, event.body)) {
    console.log("X-Hub-Signature does not match our signature."); // DEBUG:
    await handleError("if(X-Hub-Signature !== ourSignature)","X-Hub-Signature does not match our signature.",context);
    return callback(null, await genResObj400("THAT'S MY PURSE! I DON'T KNOW YOU!"));
  }

  // Check if event has X-GitHub-Event header
  // We use this later to determine if this is an event we care about.
  if(!event.headers.hasOwnProperty('X-GitHub-Event')) {
    console.log("No X-GitHub-Event found on requst");
    await handleError("if(X-GitHub-Event)","Missing X-GitHub-Event header.",context);
    return callback(null, await genResObj400("No X-GitHub-Event header found on request."));
  }

  // Check if event is a 'ping' type for testing.
  if(event.headers['X-GitHub-Event'] == "ping") {
    console.log(`X-GitHub-Event is of type ${event.headers['X-GitHub-Event']}, Whatever.`); // DEBUG:
    return callback(null, await genResObj200("I see you have the machine that goes PING!"));
  }

  // Check if event is a 'push' type since that's all we care about.
  if(event.headers['X-GitHub-Event'] != "push") {
    console.log(`githubEvent is of type ${event.headers['X-GitHub-Event']} and we just don't care.`); // DEBUG:
    return callback(null, await genResObj400("I told you I only wanted push events."));
  }

  // Check if the 'push' is to the master or dev branches since that's all we care about.
  if(githubEventObject.ref != 'refs/heads/master' && githubEventObject.ref != 'refs/heads/dev') {
    console.log(`githubEventObject.ref is to the ${githubEventObject.ref} branch and we just don't care.`); // DEBUG:
    return callback(null, await genResObj400("This just isn't anything I care about."));
  }

  // Ok, now that all of the validation checks are out of the way...
  try {

    // Retrieve the deploy.json for this repo/branch from GitHub
    const deployObj = await getDeployJSON({
      pat: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      owner: githubEventObject.repository.owner.name,
      repo: githubEventObject.repository.name,
      ref: githubEventObject.ref
    });

    // Build the data the Deployer lambda needs
    const deployData = {
      repoName: githubEventObject.repository.name,
      repoOwner: githubEventObject.repository.owner.name,
      ref: githubEventObject.ref,
      deploy: deployObj
    };

    const snsResponse = await publishToSns({
      region: context.invokedFunctionArn.split(":")[3],
      acctId: context.invokedFunctionArn.split(":")[4],
      data: deployData
    });
    console.log("snsResponse: "+JSON.stringify(snsResponse,null,2));  // DEBUG:

    callback(null, await genResObj200("Alright, alright, alright."));

  } catch(err) {
    console.log("Error Caught: ",err);  // DEBUG:
    await handleError("Error Caught", err, context);
    callback(null, await genResObj400("Deploy Failed."));
  }

};  // End exports.handler
