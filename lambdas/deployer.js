'use strict';
console.log('Loading function: Version 3.1.0');

//
// add/configure modules
const fs = require('fs');
const util = require('util');
const { Octokit } = require('@octokit/rest');
const download = require('download');
const StreamZip = require('node-stream-zip');
const AWS = require('aws-sdk');
const awsS3client = new AWS.S3({apiVersion: '2006-03-01'});
const S3 = require('s3-client');
const s3Client = S3.createClient({s3Client: awsS3client});

//
// Begin promisification process...
// Wrappers for built in fs writeFile and -readFile- functions to return a promise
const fs_writeFile = util.promisify(fs.writeFile);

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
  const snsEventObject = JSON.parse(event.Records[0].Sns.Message);
  console.log('snsEventObject: ', JSON.stringify(snsEventObject, null, 2)); // DEBUG: yeah I parsed it just to stringify it

  // Check if a github personal access token has been set as an environment variable.
  // Without this we can't retrieve private repos, this is fatal.
  if(!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.log("process.env.GITHUB_PERSONAL_ACCESS_TOKEN missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_PERSONAL_ACCESS_TOKEN)","Missing GITHUB_PERSONAL_ACCESS_TOKEN.",context);
    return callback(null, "Missing process.env.GITHUB_PERSONAL_ACCESS_TOKEN.");
  }

  // Check if a github webhook secret token has been set as an environment variable.
  // Without this we can't compare the event signature sent by GitHub
  if(!process.env.GITHUB_WEBHOOK_SECRET) {
    console.log("process.env.GITHUB_WEBHOOK_SECRET missing"); // DEBUG:
    await handleError("if(process.env.GITHUB_WEBHOOK_SECRET)","Missing GITHUB_WEBHOOK_SECRET",context);
    return callback(null, "Missing process.env.GITHUB_WEBHOOK_SECRET.");
  }

  // Ok, now that all of the validation checks are out of the way...
  try {

    // Create authorized github client (auth allows access to private repos)
    const octokit = new Octokit({
      auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    });

    // Retrieve archive of repo from github
    // Note: getArchiveLink renamed to downloadArchive as of @octokit/rest v18
    const ghArchive = await octokit.repos.downloadArchive({
      owner: snsEventObject.repoOwner,
      repo: snsEventObject.repoName,
      archive_format: 'zipball',
      ref: snsEventObject.ref
    });

    // Save the repo archive locally to /tmp/github.zip
    await fs_writeFile('/tmp/github.zip', await download(ghArchive.url));

    // Extract the archive and return the directory it was extrated into
    const extractedTo = await extractArchive('/tmp/github.zip');

    // Get deployment info from deploy.json
    const deployObj = snsEventObject.deploy;

    // Test if type within deploy.json is supported
    if(deployObj.deploy.type == "S3") {
      console.log("Deploy type: S3. Ok to proceed.");
      var branch = snsEventObject.ref.split('refs/heads/')[1];
      await deployS3(extractedTo, deployObj.deploy.target[branch]);
      callback(null, "Alright, alright, alright.");
    } else {
      console.log(`Invalid deploy type: ${deployObj.deploy.type}`);
      await handleError("Invalid deploy type.",deployObj.deploy.type,context);
      callback(null, "Invalid deploy type.");
    }

  } catch(err) {
    console.log("Error Caught: ",err);  // DEBUG:
    await handleError("Error Caught", err, context);
    callback("Deploy failed.",null);  // Deploy failed, report back to SNS to try again.
  }

};  // End exports.handler
