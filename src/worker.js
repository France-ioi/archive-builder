const path = require('path');
const tmp = require('tmp');
const util = require('util');
const stream = require('stream');
const fs = require('fs');
const crypto = require('crypto');
const doAsync = require('doasync');
const asyncFs = doAsync(fs);
const readdir = require('recursive-readdir');
const mkdirp = util.promisify(require('mkdirp'));
const JSZip = require('jszip');
const stringToStream = require('string-to-stream');
const fetch = require('fetch');
const base64 = require('base64-stream');
const unzipper = require('unzipper');

const pipeline = util.promisify(stream.pipeline);

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
    stream = stringToStream(source.content);
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
    stream = unzipper.Extract({path: targetPath});
  } else if (target.hasOwnProperty('file')) {
    stream = await buildContext.addFile(target.file);
  }
  if (target.encode === 'base64') {
    stream = stream.pipe(base64.encode());
  }
  return stream;
}

class BuildContext {
  constructor (s3, s3Bucket, s3BucketIsNew) {
    this._s3 = s3;
    this._s3Bucket = s3Bucket;
    this._s3BucketIsNew = s3BucketIsNew;
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
  async run (manifestUrl) {
    console.log('fetch manifest…')
    const taskResponse = await fetchUrl(manifestUrl);
    console.log('fetch manifest OK')
    const spec = JSON.parse(taskResponse.body);
    await this.makeTargetDir();
    for (let insn of spec.contents) {
      console.log('processing', insn);
      const inStream = makeSourceStream(insn.from);
      const outStream = await makeTargetStream(this, insn.to);
      await pipeline(inStream, outStream);
    }
    console.log('building zip…');
    await this.populateZip();
    await this.generateZip();
    console.log('building zip OK');
    const hash = await hashFile(this.targetZipPath);
    const body = await asyncFs.readFile(this.targetZipPath);
    console.log('uploading…')
    const bucket = this._s3Bucket;
    const key = `${hash}.zip`;
    await this._s3.putObject({
      Bucket: bucket,
      Key: key,
      ACL: 'public-read',
      ContentType: 'application/zip',
      Body: body
    }).promise();
    console.log('uploading OK')
    if (this._s3BucketIsNew) {
      return `https://s3.amazonaws.com/${bucket}/${key}`;
    }
    return `https://${bucket}.s3.amazonaws.com/${key}`;
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
      const content = await asyncFs.readFile(file);
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

/* Fetch manifestUrl, build the zip it describes, upload the zip to S3, and
   return the zip's URL. */
module.exports = async function (manifestUrl, {s3, s3Bucket, s3BucketIsNew}) {
  const context = new BuildContext(s3, s3Bucket);
  try {
    return await context.run(manifestUrl);
  } finally {
    context.cleanup();
  }
};
