'use strict';
console.log('Loading function: Version 4.1.0');

//
// add/configure modules
import { promises as fs } from 'fs';
import { Octokit } from '@octokit/rest';
import download from 'download';
import { s3Client } from "../libs/s3Client.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from '../libs/ddbDocClient.js';
// I had to modify s3-sync-client in node-modules to export TransferMonitor, updates may break this.
import { default as S3SyncClient, TransferMonitor } from 's3-sync-client';  
import StreamZip from 'node-stream-zip';

const { sync } = new S3SyncClient({ client: s3Client });
const monitor = new TransferMonitor();

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

      await fs.mkdir(`/tmp/${subdir}`, {recursive: true});
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
  return new Promise( async (resolve,reject) => {
    if(!source || !destination) {
      console.log("deployS3: source or destination missing.");
      return reject("deployS3(): source and destination are both required arguments.");

    } else {
      monitor.on('progress', (progress) => console.log(progress));

      const params = {
        del: true,  // --delete
        partSize: 100 * 1024 * 1024, // uses multipart uploads for files higher than 100MB
        monitor
      };  

      await sync(source, `s3://${destination}`, params)
      .then((data) => {
        console.log('sync done',data); //DEBUG
        return resolve();
      })
      .catch((err) => {
        console.log('sync err:',err); 
        return reject(new Error('deployS3:sync error'));
      }); // End sync

    } // End if source/destination
  }); // End Promise
} // End deployS3


//
// handleError
// Writes error message to DDB errorTable for reporting
function handleError(method, message, context) {
  return new Promise( async (resolve) => {
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
    try {
      const data = await ddbDocClient.send(new PutCommand(params));
      console.log("handleError:put data: ",JSON.stringify(data,null,2));  // DEBUG
      return resolve();
    } catch (err) {
      console.log("Unable to add DDB item to errorLogs: ",err); 
      // Yes this is an error, but we don't want it to kill the lambda.
      return resolve();
    }
  }); // End Promise
} // End handleError

// ****************************************************
// ****************************************************
//
// Main function begins here
export const handler = async (event, context) => {
  console.log('Received event:', JSON.stringify(event, null, 2)); // DEBUG

  // GitHub event is contained in event.body as a stringified JSON, so parse it.
  const snsEventObject = JSON.parse(event.Records[0].Sns.Message);
  console.log('snsEventObject: ', JSON.stringify(snsEventObject, null, 2)); // DEBUG: yeah I parsed it just to stringify it

  // Check if a github personal access token has been set as an environment variable.
  // Without this we can't retrieve private repos, this is fatal.
  if(!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.log("process.env.GITHUB_PERSONAL_ACCESS_TOKEN missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_PERSONAL_ACCESS_TOKEN)","Missing GITHUB_PERSONAL_ACCESS_TOKEN.",context);
    return new Error("Missing process.env.GITHUB_PERSONAL_ACCESS_TOKEN.");
  }

  // Check if a github webhook secret token has been set as an environment variable.
  // Without this we can't compare the event signature sent by GitHub
  if(!process.env.GITHUB_WEBHOOK_SECRET) {
    console.log("process.env.GITHUB_WEBHOOK_SECRET missing"); // DEBUG:
    await handleError("if(process.env.GITHUB_WEBHOOK_SECRET)","Missing GITHUB_WEBHOOK_SECRET",context);
    return new Error("Missing process.env.GITHUB_WEBHOOK_SECRET.");
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
    // await fs_writeFile('/tmp/github.zip', await download(ghArchive.url));
    await fs.writeFile('/tmp/github.zip', await download(ghArchive.url));

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
      return "Alright, alright, alright.";
    } else {
      console.log(`Invalid deploy type: ${deployObj.deploy.type}`);
      await handleError("Invalid deploy type.",deployObj.deploy.type,context);
      return new Error("Invalid deploy type.");
    }

  } catch(err) {
    console.log("Error Caught: ",err);  // DEBUG:
    await handleError("Error Caught", err, context);
    return new Error("Deploy failed.");  // Deploy failed, report back to SNS to try again.
  }

};  // End exports.handler
