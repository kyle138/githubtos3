var GitHubApi = require('github');
var github = new GitHubApi({
    version: '3.0.0'
});
// Authenticate to github
var github_token = require('./github_token.json');
github.authenticate(github_token);
var https = require('https');
var fs = require('fs');
var StreamZip = require('node-stream-zip');
var mime = require('mime');
var aws = require('aws-sdk');
var S3 = new aws.S3({apiVersion: '2006-03-01'});

var boolIssue = boolPusher = false;
var file;
var requestDataString = '';
var firstEntry = '';
var extractedTotal = uploadedCount = 0;

function getSNSMessageObject(msgString) {
    var x = msgString.replace(/\\/g,'');
    var y = x.substring(1,x.length-1);
    var z = JSON.parse(y);
    return z;
}

exports.handler = function(event, context) {
    console.log('Version: ','2.0.6');    //DEBUG
    var githubEventString = JSON.stringify(event.Records[0].Sns.Message);
    var githubEventObject = getSNSMessageObject(githubEventString);

    function getDeployJSON(err, user, repo, ref, callback) {
      //console.log("getDeployJSON::user " + user); //DEBUG
      //console.log("getDeployJSON::repo " + repo); //DEBUG
      //console.log("getDeployJSON::ref " + ref); //DEBUG
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
        ref="master";
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
          return false;
        } else {
          dataContent = JSON.parse(new Buffer(data.content, 'base64'));
          //console.log("getDeployJSON::Type " + dataContent.deploy.type); //DEBUG
          //console.log("getDeployJSON::Target " + dataContent.deploy.target); //DEBUG
          callback(null, dataContent);
        }
      });
    }

    function getDeployType(err, data) {
      if(err) {
        console.log(err);
        return;
      } else {
        if(data.deploy.type == 'S3') {
          console.log("This type is S3");	//DEBUG
          console.log("Target is " + data.deploy.target); //DEBUG
          deployS3(err, data.deploy.target);
        } else if(data.deploy.type == 'EB') {
          console.log("This type is EB");	//DEBUG
          console.log("Target is " + data.deploy.target); //DEBUG
        } else {
          console.log('deployType must be S3 or EB');
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

    // Responds to new issues opened in github, no need for this really, just shows the use of the github API.
    if (githubEventObject.hasOwnProperty('issue') && githubEventObject.action == 'opened') {
        // An event for opening an issue
        boolIssue=true;

        // Get user name of the comment poster
        var poster = githubEventObject.issue.user.login;

        github.issues.createComment({
            user: githubEventObject.repository.owner.login,
            repo: githubEventObject.repository.name,
            number: githubEventObject.issue.nummber,
            body: "Hi @" + poster + "!\n" +
                  "\n" +
                  "Thank you for your interest in this project! Unfortunately, we're " +
                  "really busy at the moment, but we'll get to your issue as soon as " +
                  "possible. Have a great day!"
        }, context.done);
    } // End Issue-Opened

    // Checks if a push has been made to the master branch, if so, deploy to S3
    if (githubEventObject.hasOwnProperty('pusher') && githubEventObject.ref == 'refs/heads/master') {
      boolPusher=true;

      // Get the archive url
      getArchive(
        githubEventObject.repository.owner.name,
        githubEventObject.repository.name,
        githubEventObject.ref,
        getDeployJSON
      );
    }  // End If(Pusher)

  // Nothing, just close it. Honestly this should never happen if the
  // GitHub webhooks are configured properly.
  if(!boolIssue&&!boolPusher) {
    context.done();
  }
};  // End exports.handler