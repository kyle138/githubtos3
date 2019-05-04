'use strict';
console.log('Loading function: Version 3.0.1');

//
// add/configure modules
const fs = require('fs');
const util = require('util');
const crypto = require('crypto');
const GitHubApi = require('@octokit/rest');
const StreamZip = require('node-stream-zip');
const AWS = require('aws-sdk');
const awsS3client = new AWS.S3({apiVersion: '2006-03-01'});
const S3 = require('s3-client');
const s3Client = S3.createClient({s3Client: awsS3client});

//
// Begin promisification process...
// Wrappers for built in fs writeFile and readFile functions to return a promise
const fs_writeFile = util.promisify(fs.writeFile);
const fs_readFile = util.promisify(fs.readFile);

//
// Sign the request body
function signRequestBody(key, body) {
  return `sha1=${crypto.createHmac('sha1', key).update(body, 'utf-8').digest('hex')}`;
} // End signRequestBody

//
// Extract the archive
function extractArchive(archive) {
  return new Promise( (resolve, reject) => {
    if(!archive) {
      console.log("extractArchive: no archive");  // DEBUG:
      return reject("extractArchive(): archive is a required argument.");
    } else {
      const zip = new StreamZip({
        file: archive,
        storeEntries: true
      });

      zip.on('error', err => {
        console.log("extractArchive::zip error: "+ err);
        return reject("Zip error");
      });

      zip.on('ready', () => {
        console.log('extractArchive::Entries read: '+ zip.entriesCount);  // DEBUG:

        // The first entry should be the subdirectory added by github.
        // Capture its name here for the return
        // This will be used later to know where the files were extracted to
        var extractionDestination = '/tmp/'+Object.keys(zip.entries())[0];

        // Extract everything to /tmp, be mindful of the 500MB cumulative limit
        zip.extract(null, '/tmp', (err, count) => {
          if(err) {
            console.log("extractArchive::zip.extract error:: "+err);
            return reject("Zip Extract error.");
          } else {
            console.log(`extractArchive::Extracted ${count} entries to ${extractionDestination}`);  // DEBUG:
            zip.close();
            return resolve(extractionDestination);
          } //Commencing ridiculously long closing bracket sequence...
        }); // End zip.extract
      }); // End zip.on(ready)
    } // End if archive
  }); // End Promise
} // End extractArchive

//
// getDeployJSON
// Open and parse the deploy.json provided in the repo
// 'location' is the folder the repo archive has been extracted to
function getDeployJSON(location) {
  return new Promise( (resolve, reject) => {
    if(!location) {
      console.log("getDeployJSON: no location"); // DEBUG:
      return reject("getDeployJSON(): location is a required argument.");
    } else {
      fs_readFile(location+'deploy.json', {encoding: 'utf8'})
      .then((data) => {
        console.log(`getDeployJSON.readFile.data: ${data}`);  // DEBUG:
        validateDeployJSON(JSON.parse(data))
        .then(() => {
          console.log("getDeployJSON:validateDeployJSON: checks out."); // DEBUG:
          return resolve(JSON.parse(data));
        })
        .catch(() => {
          console.log("getDeployJSON:validateDeployJSON: invalid format.");// DEBUG:
          return reject("Invalid deploy.json format");
        });
      })
      .catch((err) => {
        console.log("getDeployJSON.readFile Error: ", err);
        return reject("getDeployJSON.readFile Error.");
      });
    }
  });  // End Promise
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
// deployS3
// Sync the extracted folder to the S3 bucket
function deployS3(source, destination) {
  return new Promise( (resolve,reject) => {
    if(!source || !destination) {
      console.log("deployS3: source or destination missing.");
      return reject("deployS3(): source and destination are both required arguments.");
    } else {
      var params = {
        localDir: source,
        deleteRemoved: true,
        s3Params: {
          Bucket: destination
        }
      }; // End params

      var syncer = s3Client.uploadDir(params);

      syncer.on('error', (err) => {
        console.log("deployS3::s3Client.uploadDir error: ", err);
      });

      syncer.on('progress', () => {
        console.log("deployS3::uploadDir progress", syncer.progressAmount, syncer.progressTotal);// DEBUG:
      });

      syncer.on('end', () => {
        console.log("deployS3::uploadDir done."); // DEBUG:
        return resolve();
      }); // End syncer
    } // End if source/destination
  }); // End Promise
} // End deployS3

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
    new AWS.DynamoDB.DocumentClient({region: 'us-west-2'}).put(params, function(err, data) {
      if (err) console.log("Unable to add DDB item to errorLogs: "+JSON.stringify(err, null, 2));
      return resolve();
    }); // End DDB.put
  }); // End Promise
} // End handleError

// ****************************************************
// ****************************************************
//
// Main function begins here
module.exports.deployer = async (event, context, callback) => {
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
  if(event.headers['X-GitHub-Event'] != "ping") {
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

    // Create authorized github client (auth allows access to private repos)
    var github = new GitHubApi({
      auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    });

    // Retrieve archive of repo from github
    // getArchiveLink previously only returned the link used to d/l the zipball
    // It still does that but now it also returns the entire archive as well? ¯\_(ツ)_/¯
    // It may be depricated and replaced by getArchive() later
    // So why am I still using getArchiveLink() you ask?
    // Because getArchive() doesn't exist yet
    // Yeah, I'm as impressed with this as you are
    const ghArchive = await github.repos.getArchiveLink({
      owner: githubEventObject.repository.owner.name,
      repo: githubEventObject.repository.name,
      archive_format: 'zipball',
      ref: githubEventObject.ref
    });

    // Save the repo archive locally in the /tmp directory
    await fs_writeFile('/tmp/github.zip', ghArchive.data);

    // Extract the archive and return the directory it was extrated into
    const extractedTo = await extractArchive('/tmp/github.zip');

    // Get deployment info from deploy.json
    const deployObj = await getDeployJSON(extractedTo);

    // Test if type within deploy.json is supported
    if(deployObj.deploy.type == "S3") {
      console.log("Deploy type: S3. Ok to proceed.");
      var branch = githubEventObject.ref.split('refs/heads/')[1];
      await deployS3(extractedTo, deployObj.deploy.target[branch]);
      callback(null, await genResObj200("Alright, alright, alright."));
    } else {
      console.log(`Invalid deploy type: ${deployObj.deploy.type}`);
      await handleError("Invalid deploy type.",deployObj.deploy.type,context);
      callback(null, await genResObj200("Invalid deploy type."));
    }

  } catch(err) {
    console.log("Error Caught: ",err);  // DEBUG:
    await handleError("Error Caught", err, context);
    callback(null, await genResObj200("Deploy failed."));
  }

};  // End exports.handler
