
require('dotenv').config();
const http = require('http');
const path = require('path');
const tmp = require('tmp');
const util = require('util');
const stream = require('stream');
const pfs = require('nano-fs');
const fs = require('fs');
const crypto = require('crypto');

const pify = require('pify');
const express = require('express');
const bodyParser = require('body-parser');
const readdir = require('recursive-readdir');
const mkdirp = pify(require('mkdirp'));
const JSZip = require('jszip');
const aws = require('aws-sdk');
const str = require('string-to-stream');
const fetch = require('fetch');
const base64 = require('base64-stream');
const unzip = require('unzip');

const pipeline = util.promisify(stream.pipeline);

const config = {
  isDevelopment: process.env.NODE_ENV !== 'production',
  port: process.env.PORT || '8000'
};
const s3 = new aws.S3({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION
});

function fetchUrl (url) {
  return new Promise (function (resolve, reject) {
    fetch.fetchUrl(url, function (error, meta, body) {
      if (error) return reject(error);
      return resolve({meta, body});
    });
  });
}

function hashFile (filepath) {
  return new Promise (function (resolve, reject) {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filepath);
    input.on('readable', () => {
      const data = input.read();
      if (data) {
        hash.update(data);
      } else {
        resolve(hash.digest('hex'));
      }
    });
    input.on('error', reject);
  });
}

function makeSourceStream (source) {
  let stream;
  if (source.hasOwnProperty('url')) {
    stream = new fetch.FetchStream(source.url);
  } else if (source.hasOwnProperty('string')) {
    stream = str(source.content);
  } else if (source.hasOwnProperty('file')) {
    // XXX append target dir if relative path
    // XXX disallow absolute path?
    stream = fs.createReadStream(source.file);
  }
  if (source.decode === 'base64') {
    stream = stream.pipe(base64.decode());
  }
  return stream;
}

async function makeTargetStream (buildContext, target) {
  let stream;
  if (target.hasOwnProperty('unzip')) {
    const targetPath = await buildContext.addFolder(target.unzip);
    stream = unzip.Extract({path: targetPath});
  } else if (target.hasOwnProperty('file')) {
    stream = await buildContext.addFile(target.file);
  }
  if (target.encode === 'base64') {
    stream = stream.pipe(base64.encode());
  }
  return stream;
}

class BuildContext {
  constructor (req, res) {
    this._req = req;
    this._res = res;
    this._cleanupCallbacks = [];
    this._zip = new JSZip();
  }
  cleanup () {
    for (let cb of this._cleanupCallbacks) {
      cb();
    }
  }
  addCleanupCallback (cb) {
    this._cleanupCallbacks.unshift(cb);
  }
  async run (query) {
    const taskResponse = await fetchUrl(query.task);
    const spec = JSON.parse(taskResponse.body);
    await this.makeTargetDir();
    for (let insn of spec.contents) {
      const inStream = makeSourceStream(insn.from);
      const outStream = await makeTargetStream(this, insn.to);
      await pipeline(inStream, outStream);
    }
    await this.populateZip();
    await this.generateZip();
    const hash = await hashFile(this.targetZipPath);
    const body = await pfs.readFile(this.targetZipPath);
    const bucket = process.env.S3_BUCKET;
    const key = `${hash}.zip`;
    await s3.putObject({
      Bucket: bucket,
      Key: key,
      ACL: 'public-read',
      ContentType: 'application/zip',
      Body: body
    }).promise();
    return `https://s3.amazonaws.com/${bucket}/${key}`;
  }
  makeTargetDir () {
    return new Promise ((resolve, reject) => {
      tmp.dir({unsafeCleanup: true}, (err, path, cleanupCallback) => {
        if (err) return reject(err);
        this.addCleanupCallback(cleanupCallback);
        this.targetDir = path;
        resolve();
      });
    });
  }
  makeTargetZip () {
    return new Promise ((resolve, reject) => {
      tmp.file({postfix: '.zip'}, (err, path, fd, cleanupCallback) => {
        if (err) return reject(err);
        this.addCleanupCallback(cleanupCallback);
        this.targetZipPath = path;
        const zipStream = fs.createWriteStream(null, {fd: fd, encoding: 'binary'});
        resolve(zipStream);
      });
    });
  }
  async populateZip () {
    const files = await readdir(this.targetDir);
    const prefixLen = this.targetDir.length + 1;
    for (let file of files) {
      const relPath = file.substring(prefixLen);
      const content = await pfs.readFile(file);
      this._zip.file(relPath, content);
    }
  }
  async generateZip () {
    const inStream = this._zip.generateNodeStream({compression: 'DEFLATE'});
    const outStream = await this.makeTargetZip();
    await pipeline(inStream, outStream);
  }
  async addFolder (relPath) {
    const absPath = path.join(this.targetDir, relPath);
    await mkdirp(absPath);
    return absPath;
  }
  async addFile (filename) {
    const absPath = path.join(this.targetDir, filename);
    await mkdirp(path.dirname(absPath));
    return fs.createWriteStream(absPath);
  }
}

const app = express();
app.enable('strict routing');
app.use(bodyParser.json());
app.get('/', function (req, res) {
  const context = new BuildContext(req, res);
  context.run(req.query).then(function (url) {
    context.cleanup();
    res.redirect(url);
  }, function (err) {
    context.cleanup();
    res.status(500).send(err.stack);
  });
});
const server = http.createServer(app);
console.info(`Starting on port ${config.port}`)
server.listen(config.port);

