'use strict';
console.log('Loading function: Version 3.0.0');

//
// add/configure modules
const fs = require('fs');
const util = require('util');
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
      header: {
        'Content-Type': 'application/json',
      }
    };
    return resolve(res200);
  }); // End Promise
} // End generateResponseObject200

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
//
// Main function begins here
module.exports.githubToS3 = async (event, context, callback) => {
  console.log('Received event:', JSON.stringify(event, null, 2)); // DEBUG

  // GitHub event is contained in event.body as a stringified JSON
  var githubEventObject = JSON.parse(event.body);

  // Checks if this event is actually a push event, we don't care about other event types
  if (githubEventObject.hasOwnProperty('pusher')) {

    // Check if push was to master or dev branch, we don't care about other branches
    if (githubEventObject.ref == 'refs/heads/master' || githubEventObject.ref == 'refs/heads/dev') {
      console.log(`githubEventObject.ref : ${githubEventObject.ref}`); //DEBUG

      // Check if required environment variable github_token is set.
      // Without this we can't retrieve private repos, this is fatal.
      if(!process.env.github_token) {
        // await handleError("handler", "Missing github_token env var.", context);
        console.log("process.env.github_token missing");  // DEBUG:
        await handleError("if(process.env.github_token)","Missing github_token.",context);
        callback(null, "FATAL: Missing github_token.");
      } else {
        try {

          // Create authorized github client (auth allows access to private repos)
          var github = new GitHubApi({
            auth: process.env.github_token
          });

          // Retrieve archive of repo from github
          // getArchiveLink previously only returned the link used to d/l the zipball
          // It still does that but now it also returns the entire archive as well? ¯\_(ツ)_/¯
          // It may be depricated and replaced by getArchive() later
          // So why am I still using getArchiveLink() you ask?
          // Because getArchive() doesn't exist yet
          // Yeah, I'm as impressed with GH as you are
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

      } // End if/else proc.env.github_token
    } // End is master/dev
  } // End hasOwnProperty(pusher)
};  // End exports.handler
