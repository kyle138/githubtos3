'use strict';
console.log('Loading function: Version 4.0.0');

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
// params: {object}
// archive: {string} - The path to the archive to extract.
// subdir: {string} - <optional> If present, extract the subdirectory from the archive.
function extractArchive(params) {
  return new Promise(async (resolve, reject) => {
    if(!params.archive) {
      console.log("extractArchive: no archive");  // DEBUG
      return reject("extractArchive(): archive is a required argument.");
    } else {
      console.log('extractArchive::params: ',JSON.stringify(params,null,2));  //DEBUG
      const zip = new StreamZip.async({
        file: params.archive,
        storeEntries: true
      });

      // Get the list of directories and files in this archive
      const zipEntries = Object.keys(await zip.entries());
      // The first entry will always be the subdirectory added by github based on this commit hash
      // If no subdir provided only extract the github subdirectory, otherwise extract the githubsubdir/providedsubdir
      const subdir = (params.subdir === null) ? zipEntries[0] : zipEntries[0]+params.subdir;
      if(!zipEntries.includes(subdir)) {
        console.log('This subdirectory does not exist!!!'); //DEBUG
        console.log(zipEntries);  //DEBUG
        return reject(`extractArchive::error: The subdirectory ${params.subdir} does not exist in the archive.`);
      }

      fs.mkdirSync(`/tmp/${subdir}`, {recursive: true});
      await zip.extract(subdir, '/tmp/'+subdir)
      .then(async (count) => {
        console.log(`Extracted ${count} entries to /tmp/${subdir}.`);  
        await zip.close();
        // return the directory the files were extracted to so deployS3 knows where to find them.
        return resolve('/tmp/'+subdir);
      })
      .catch(async (err) => {
        console.log("extractArchive::zip error: "+err); 
        await zip.close();
        return reject("Zip error");
      }); // End zip.extract
    } // End if !params.archive
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

    // Get deployment info from deploy.json
    const deployObj = snsEventObject.deploy;

    // Check if deploy.json has a subdir set
    const subdir = deployObj.deploy?.subdir ? deployObj.deploy.subdir : null;

    // Extract the archive and return the directory it was extrated into
    const extractedTo = await extractArchive({
      subdir: subdir,
      archive: '/tmp/github.zip'
    });

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
