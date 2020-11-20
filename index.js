require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const asyncHandler = require('express-async-handler');
const doAsync = require('doasync');
const jwt = doAsync(require('jsonwebtoken'));
const aws = require('aws-sdk');
const Datastore = require('nedb');
const Queue = require('better-queue');

const worker = require('./src/worker');
const rootDir = __dirname;

function P (f) {
  return new Promise(function (resolve, reject) {
    try {
      f(function (err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
const config = {
  isDevelopment: process.env.NODE_ENV !== 'production',
  port: process.env.PORT || '8000',
  baseUrl: process.env.BASE_URL || '/'
};
config.rebaseUrl = function(url) {
  return `${config.baseUrl}/${url}`;
}

const jobs = new Datastore({
  filename: path.join(rootDir, 'jobs.db'),
  autoload: true
});
const s3 = new aws.S3({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION
});

function sha256 (text) {
  return crypto.createHash('sha256')
    .update(text.toString())
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const jobQueue = new Queue(function ({manifestUrl}, cb) {
  worker(manifestUrl, {
    s3: s3,
    s3Bucket: process.env.S3_BUCKET,
    s3BucketIsNew: process.env.S3_BUCKET_IS_NEW === '1'
  }).then(function (url) {
    cb(null, {url});
  }, function (err) {
    cb(err);
  });
}, {
  maxTimeout: 120 * 1000 /* milliseconds */
});
jobQueue.on('task_accepted', function (taskId, task) {
  jobs.update({taskKey: task.taskKey}, {$set: {status: 'accepted', taskId}});
});
jobQueue.on('task_queued', function (taskId, task) {
  jobs.update({taskId}, {$set: {status: 'queued'}});
});
jobQueue.on('task_started', function (taskId, task) {
  jobs.update({taskId}, {$set: {status: 'started'}});
});
jobQueue.on('task_finish', function (taskId, result, stats) {
  jobs.update({taskId}, {$set: {status: 'finished', result, stats}});
});
jobQueue.on('task_failed', function (taskId, err, stats) {
  jobs.update({taskId}, {$set: {status: 'failed', error: err, stats}});
});
jobQueue.on('task_progress', function (taskId, progress) {
  jobs.update({taskId}, {$set: {progress}});
});
jobQueue.on('task_retry', function (taskId, retries) {
  jobs.update({taskId}, {$set: {retries}});
});

let app = express();

app.enable('strict routing');
app.set('view engine', 'pug');
app.set('views', path.join(rootDir, 'views'));

app.use('/assets', express.static(path.join(rootDir, 'assets')));

app.get('/', asyncHandler(async (req, res) => {
  const token = await jwt.verify(req.query.t, process.env.SECRET, {audience: 'builder'});
  const manifestUrl = token.manifestUrl;
  const taskKey = sha256(manifestUrl);

  let job = await P(cb => jobs.findOne({taskKey}, cb));
  if (!job) {
    await P(cb => jobs.insert({taskKey, manifestUrl}, cb));
    job = {taskKey, manifestUrl};
    jobQueue.push(job);
  }

  res.redirect(`${config.baseUrl}/jobs/${job.taskKey}`);
}));

app.get('/jobs/:taskKey', asyncHandler(async (req, res) => {
  const taskKey = req.params.taskKey;

  const job = await P(cb => jobs.findOne({taskKey}, cb));
  if (!job) {
    return res.status(404).send("Not Found");
  }
  if (job.status !== 'finished' && job.status !== 'error') {
    res.header('Refresh', 5);
  }

  res.render('job', {
    job,
    rebaseUrl: config.rebaseUrl
  });
}));

console.info(`Starting on port ${config.port}`)

// Configure base URL.
console.log(`App base URL ${config.baseUrl}`);
const rootApp = express();
rootApp.use(config.baseUrl, app);

const server = http.createServer(rootApp);
server.listen(config.port);
