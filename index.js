'use strict';

//
// add/configure modules
const GitHubApi = require('@octokit/rest');

const https = require('https');
const fs = require('fs');
const StreamZip = require('node-stream-zip');
//var mime = require('mime');
const aws = require('aws-sdk');
const awsS3client = new aws.S3({apiVersion: '2006-03-01'});
const S3 = require('s3-client');
const s3Client = S3.createClient({s3Client: awsS3client});

//
// Initialize initial variables, initially. -KM (My initials)
var boolIssue = boolPusher = false;
var file;
var requestDataString = '';
var firstEntry = '';
var extractedTotal = uploadedCount = 0;

//
// Authenticate to github for API calls to private repos
// Get token from process.env.github_token
function authenticateGitHub(token) {
  return new Promise(function(resolve, reject) {
    if(!token) {
      return reject("AuthenticateGitHub(): token is a required argument.");
    } else {
      return resolve( new GitHubApi({
          auth: process.env.github_token,
          userAgent: 'octokit/rest.js v16.23.4'
        })
      );  // End return resolve
    } // End if token
  }) // End Promise
} // End authenticateGitHub

exports.handler = (event, context, callback) => {
    console.log('Version: ','3.0.0');
    console.log('Received event:', JSON.stringify(event,null,2)); //DEBUG
    var githubEventObject = JSON.parse(event.body);

    function getDeployJSON(err, user, repo, ref, callback) {
      console.log("getDeployJSON::user " + user); //DEBUG
      console.log("getDeployJSON::repo " + repo); //DEBUG
      console.log("getDeployJSON::ref " + ref); //DEBUG
      if(err) {
        context.fail(err);
        return;
      }
      if(!user) {
        //console.log("getDeployTarget::field user is required");
        callback( new Error('Parameter user is required') );
        return;
      }
      if(!repo) {
        //console.log("getDeployTarget::field repo is required");
        callback( new Error('Parameter repo is required') );
        return;
      }
      if(!ref) {
        ref='refs/heads/master'; // Default to master, this could also be dev
      }
      var apiMsg = {
        user: user,
        repo: repo,
        path: "deploy.json",
        ref: ref
      };
      github.repos.getContent( apiMsg , function(err, data) {
        if (err) {
          console.log("deploy.json is missing from this repo: "+err);
          context.fail(err);
          return false;
        } else {
          dataContent = JSON.parse(new Buffer(data.content, 'base64'));
          //console.log("getDeployJSON::Type " + dataContent.deploy.type); //DEBUG
          //console.log("getDeployJSON::Target.master " + dataContent.deploy.target.master); //DEBUG
          //console.log("getDeployJSON::Target.dev " + dataContent.deploy.target.dev); //DEBUG
          callback(null, dataContent, ref);
        }
      });
    }

    function getDeployType(err, data, branch) {
      if(!data) {
        callback( new Error('Parameter data is required'));
        return;
      }
      if(!branch) {
        branch="master";
      }
      if(err) {
        console.log(err);
        return;
      } else {
        if(data.deploy.type == 'S3') {
          if(branch == 'refs/heads/master') {
            if(!data.deploy.target.master) {
              console.log("target.master is not assigned in deploy.json.");
              context.fail("target.master is not assigned in deploy.json.");
            } else {
              console.log("This type is S3");	//DEBUG
              console.log("Target is " + data.deploy.target.master); //DEBUG
              deployS3(err, data.deploy.target.master);
            }
          } else if(branch == 'refs/heads/dev') {
            if(!data.deploy.target.dev) {
              console.log("target.dev is not assigned in deploy.json.");
              context.fail("target.dev is not assigned in deploy.json.");
            } else {
              console.log("This type is S3");	//DEBUG
              console.log("Target is " + data.deploy.target.dev); //DEBUG
              deployS3(err, data.deploy.target.dev);
            }
          } else {
            console.log("Unsupported branch: " + branch); //DEBUG
            context.fail();
          }
        } else if(data.deploy.type == 'EB') {
          if(branch=='refs/heads/master') {
            if(!data.deploy.target.master) {
              console.log("target.master is not assigned in deploy.json.");
              context.fail("target.master is not assigned in deploy.json.");
            } else {
              console.log("This type is EB");	//DEBUG
              console.log("Target is " + data.deploy.target.master); //DEBUG
              console.log("This may be enabled in a future version.");  //#HighHopes
            }
          } else if(branch=='refs/heads/dev') {
            if(!data.deploy.target.dev) {
              console.log("target.dev is not assigned in deploy.json.");
              context.fail("target.dev is not assigned in deploy.json.");
            } else {
              console.log("This type is EB");	//DEBUG
              console.log("Target is " + data.deploy.target.dev); //DEBUG
              console.log("This may be enabled in a future version.");  //#HighHopes
            }
          }
        } else {
          console.log('deployType must be S3 or EB');
          context.fail();
          return;
        }
      }
    }

    function getArchive(user, repo, ref, callback) {
      var apiMsg = {
        user: user,
        repo: repo,
        ref: ref,
        archive_format: 'zipball'
      };
      github.repos.getArchiveLink( apiMsg , function(err, data) {
        if(err) {
          console.log("getArchiveLink failed");
          context.fail(err);
          return;
        } else {
          var archiveLink = JSON.stringify(data.meta.location);
          archiveLink=archiveLink.substring(1,archiveLink.length-1);  //Slay the frakking ""s!!!
          file = fs.createWriteStream('/tmp/github.zip');
          var request = https.get(archiveLink, function(response) {
            response.on('data', function(chunkBuffer) {
              // var data is a chunk of data from response body
              requestDataString += chunkBuffer.toString();
            });
            response.on('end', function() {
              console.log("GitHub Zipball received...");  //DEBUG
            });
            response.pipe(file);
            file.on('uncaughtException', function(err) {
              //console.log("File failed: "+err);
              context.fail("File failed: "+err);
            });
            file.on('finish', function() {
              file.close();
              callback(null, user, repo, ref, getDeployType);
            });
          });
          request.on('error', function(e) {
            console.log("Request error"); //DEBUG
            console.error(e);
            context.fail();
          });
          request.end( function() {
          });
        } // End else
      }); // End getArchiveLink
    } // End getArchive

    function deployS3(err, target) {
      if(err) {
        console.log("deployS3 error");
      } else {
        var zip = new StreamZip({
          file: '/tmp/github.zip',
          storeEntries: true
        });
        zip.on('error', function(err) {
          context.fail("Zip failed: "+err);
        });
        zip.on('ready', function() {
          console.log("Entries read: "+zip.entriesCount); //DEBUG
          // The first entry should be the subdirectory added by github.
          // We don't want to upload that to S3 so capture it here
          // so it can be pruned from the S3 key during upload.
          firstEntry = Object.keys(zip.entries())[0];
          // extract to /tmp (remember the 500mb limit, this is cumulative)
          zip.extract(null, '/tmp', function(err, count) {
            if (err) {
              context.fail("zip failed: "+err);
            } else {
              extractedTotal = count;
              console.log("Extracted files:: " + extractedTotal); //DEBUG
            }
          });
        });
        zip.on('extract', function(entry, file) {
          fs.readFile(file, function(err, data) {
            if (err) {
              console.log("readFile Failed: ",err); //DEBUG
              context.fail(err);
            } else {
              var key = entry.name;
              // Pruning the subdirectory mentioned above.
              key = key.replace(firstEntry,'');
              // S3 defaults to binary ContentType if not specified.
              var mimeType=mime.lookup(file);
              var params = {
                Bucket: target,
                Key: key,
                ContentType: mimeType,
                Body: data
              };
              S3.upload(params, function(err, data) {
                if(err) {
                  context.fail("S3Upload failed: "+err);
                } else {
                  // Keep track of uploaded files to avoid race condition.
                  // once it equals the number of extracted files context.succeed
                  uploadedCount++;
                  //console.log("S3 Upload: " + uploadedCount); //DEBUG
                  if(uploadedCount==extractedTotal) {
                    console.log(uploadedCount+" files deployed to "+target); //DEBUG
                    context.succeed();  // That's all folks
                  }
                }
              }); // End S3.upload()
            } // End readFile else
          }); // End readFile()
        }); // End zip.on('extract')
        zip.on('entry', function(entry) {
          //console.log("Read entry ", entry.name); //DEBUG
        });
      }
    } // End deployS3

    // If deploy.type is EB
    function deployEB(err, target) {
      console.log("Deploy to Elastic Beanstalk functionality not currently supported.");
      context.done(); // deployEB may be added at a future date.
    } // End deployEB

// handleError
// Output error information
function handleError(method, message, context) {
  return new Promise(function(resolve) {
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
        data: errorObject
      }
    };  // End params

    // Load the DDB client and write the errorLogs
    new AWS.DynamoDB.DocumentClient().put(params, function(err, data) {
      if (err) console.log("Unable to add DDB item to errorLogs: "+JSON.stringify(err, null, 2));
      return resolve();
    }); // End DDB.put
  }); // End Promise
} // End handleError


// ************************************************************
//
// main function
exports.handler = async (event, context, callback) => {
  console.log('Version: ','3.0.0');
  console.log('Received event:', JSON.stringify(event,null,2)); //DEBUG

  // GitHub event is contained in event.body as stringified json.
  var githubEventObject = JSON.parse(event.body);

  // Checks if a push has been made to the master branch, if so, deploy to S3
  if (githubEventObject.hasOwnProperty('pusher')) {
    // if push to master/dev branch, deploy to deploy.target.master
    if (githubEventObject.ref == 'refs/heads/master' || githubEventObject.ref == 'refs/heads/dev') {
      console.log("githubEventObject.ref : ", githubEventObject.ref); //DEBUG

      if(!process.env.github_token) {
        // Required github_token environment variable is not set, fatal
        await handleError("handler", "Missing github_token env var.", context);
        callback(null, "FATAL: Missing github_token.");
      } else {
        var github = await authenticateGitHub(process.env.github_token);
      }
      // Get the archive url
      getArchive(
        githubEventObject.repository.owner.name,
        githubEventObject.repository.name,
        githubEventObject.ref,
        getDeployJSON
      );
    }
  }  // End If(Pusher)
};  // End exports.handler
