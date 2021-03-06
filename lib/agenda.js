var Job = require('./job.js'),
  humanInterval = require('human-interval'),
  utils = require('util'),
  Emitter = require('events').EventEmitter;
var MongoClient = require('mongodb').MongoClient;

var Agenda = module.exports = function(config) {
  if (!(this instanceof Agenda)) {
    return new Agenda(config);
  }
  config = config ? config : {};
  this._name = config.name;
  this._processEvery = humanInterval(config.processEvery) || humanInterval('5 seconds');
  this._defaultConcurrency = config.defaultConcurrency || 5;
  this._maxConcurrency = config.maxConcurrency || 20;
  this._definitions = {};
  this._runningJobs = [];
  this._jobQueue = [];
  this._defaultLockLifetime = config.defaultLockLifetime || 10 * 60 * 1000; //10 minute default lockLifetime
  if (config.db) {
    this.database(config.db.address, config.db.collection, config.db.options);
  } else if (config.mongo) {
    this._db = config.mongo;
  }
};

utils.inherits(Agenda, Emitter);

// Configuration Methods

Agenda.prototype.mongo = function(db) {
  this._db = db;
  return this;
};

Agenda.prototype.database = function(url, collection, options) {
  collection = collection || 'agendaJobs';
  options = options || {w: 0};
  if (!url.match(/^mongodb:\/\/.*/)) {
    url = 'mongodb://' + url;
  }
  var ignoreErrors = function() {};

  var self = this;
  MongoClient.connect(url, function(err, db) {
    self._db = db.collection(collection);
    self._db.ensureIndex({"name" : 1, "priority" : -1, "lockedAt" : 1, "nextRunAt" : 1, "disabled" : 1}, ignoreErrors);
    self._db.ensureIndex({ "name" : 1, "lockedAt" : 1, "priority" : -1, "nextRunAt" : 1, "disabled" : 1 } , ignoreErrors);
  })

  return this;
};

Agenda.prototype.name = function(name) {
  this._name = name;
  return this;
};

Agenda.prototype.processEvery = function(time) {
  this._processEvery = humanInterval(time);
  return this;
};

Agenda.prototype.maxConcurrency = function(num) {
  this._maxConcurrency = num;
  return this;
};

Agenda.prototype.defaultConcurrency = function(num) {
  this._defaultConcurrency = num;
  return this;
};

Agenda.prototype.defaultLockLifetime = function(ms){
  this._defaultLockLifetime = ms;
  return this;
};

// Job Methods
Agenda.prototype.create = function(name, data) {
  var priority = this._definitions[name] ? this._definitions[name].priority : 0;
  var job = new Job({name: name, data: data, type: 'normal', priority: priority, agenda: this});
  return job;
};

Agenda.prototype.jobs = function() {
  var args = Array.prototype.slice.call(arguments);
  var arg1 = args[0];
  arg1.$exists = false;

  if (typeof args[args.length - 1] === 'function') {
    this._db.find(arg1).toArray(function(err, docs) {
      args[args.length - 1](err, docs);
    });
  }
  else{
    return this._db.find(arg1).toArray();
  }};

Agenda.prototype.purge = function(cb) {
  var definedNames = Object.keys(this._definitions);
  this._db.remove({name: {$not: {$in: definedNames}}}, cb);
};

Agenda.prototype.define = function(name, options, processor) {
  if (!processor) {
    processor = options;
    options = {};
  }
  this._definitions[name] = {
    fn: processor,
    concurrency: options.concurrency || this._defaultConcurrency,
    priority: options.priority || 0,
    lockLifetime: options.lockLifetime || this._defaultLockLifetime,
    running: 0
  };
};

Agenda.prototype.every = function(interval, names, data, startTime, endTime) {
  var self = this;

  try{
    startTime = startTime ? new Date(startTime) : new Date(1990, 1, 1);
    endTime   = endTime ? new Date(endTime) : new Date(2099, 1, 1);
  } catch (err){
    throw(err);
  }
  if (typeof names === 'string' || names instanceof String) {
    return createJob(interval, names, data);
  } else if (Array.isArray(names)) {
    return createJobs(interval, names, data);
  }

  function createJob(interval, name, data) {
    var job = self.create(name, data);
    job.attrs.type = 'single';
    job.repeatEvery(interval);
    job.attrs.startTime = startTime;
    job.attrs.endTime = endTime;
    job.attrs.status = 1;  // 1: active, 0: inactive
    job.attrs.lockedAt = null;
    job.computeNextRunAt();
    job.save();
    return job;
  }

  function createJobs(interval, names, data, startTime, endTime) {
    return names.map(function (name) {
      return createJob(interval, name, data, startTime, endTime);
    });
  }
};

Agenda.prototype.schedule = function(when, names, data) {
  var self = this;

  if (typeof names === 'string' || names instanceof String) {
    return createJob(when, names, data);
  } else if (Array.isArray(names)) {
    return createJobs(when, names, data);
  }

  function createJob(when, name, data) {
    var job = self.create(name, data);
    job.schedule(when);
    job.save();
    return job;
  }

  function createJobs(when, names, data) {
    return names.map(function (name) {
      return createJob(when, name, data);
    });
  }
};

Agenda.prototype.now = function(name, data) {
  var job = this.create(name, data);
  job.schedule(new Date());
  job.save();
  return job;
};

Agenda.prototype.cancel = function(query, cb) {
  return this._db.remove(query, cb);
};

Agenda.prototype.saveJob = function(job, cb) {
  var fn = cb,
      self = this;

  var props = job.toJSON();
  var id = job.attrs._id;
  var unique = job.attrs.unique;

  delete props._id;
  delete props.unique;

  props.lastModifiedBy = this._name;

  var now = new Date(),
      protect = {},
      update = { $set: props };

  if (id) {
    this._db.findOneAndUpdate(
      {_id: id},
      update, 
      {
        returnOriginal: false
      }, 
      processFindAndModifyResult
    );
  } else if (props.type == 'single') {
    if (props.nextRunAt && props.nextRunAt <= now) {
      protect.nextRunAt = props.nextRunAt;
      delete props.nextRunAt;
    }
    if (Object.keys(protect).length > 0) {
      update.$setOnInsert = protect;
    }
    // Try an upsert.
    this._db.findOneAndUpdate(
      {name: props.name, type: 'single','delete': {'$exists': false}},
      update, 
      {upsert: true, returnOriginal: false}, 
      processFindAndModifyResult
    );
  } else if (unique) {
    var query = job.attrs.unique;
    query.name = props.name;
    query.$exists = false;
    this._db.findOneAndUpdate(
      query,
      update, 
      {upsert: true, returnOriginal: false}, 
      processFindAndModifyResult
    );
  } else {
    this._db.insertOne(props, processDbResult);
  }

  function processFindAndModifyResult(err, res) {
    if (err) {
      throw(err);
    } else if (res && res.value) {
        job.attrs._id = res.value._id;
        job.attrs.nextRunAt = res.value.nextRunAt;
    }
    if (fn) {
      fn(err, job);
    }
  }

  function processDbResult(err, res) {
    if (err) {
      throw(err);
    } else if (res) {
        var doc = res.ops[0];
        job.attrs._id = doc._id;
        job.attrs.nextRunAt = doc.nextRunAt;  
        // if (job.attrs.nextRunAt && job.attrs.nextRunAt < self._nextScanAt) {
        //   processJobs.call(self, job);
        // }
    }

    if (fn) {
      fn(err, job);
    }
  }
};

// Job Flow Methods

Agenda.prototype.start = function() {
  if (!this._processInterval) {
    this._processInterval = setInterval(processJobs.bind(this), this._processEvery);
    process.nextTick(processJobs.bind(this));
  }
};

Agenda.prototype.stop = function(cb) {
  cb = cb || function() {};
  clearInterval(this._processInterval);
  this._processInterval = undefined;
  unlockJobs.call(this, cb);
};

/**
 * Find and lock jobs
 * @param {String} jobName
 * @param {Function} cb
 * @protected
 */
Agenda.prototype._findAndLockNextJob = function(jobName, definition, cb) {
  var now = new Date(),
      lockDeadline = new Date(Date.now().valueOf() - definition.lockLifetime);

  this._db.findOneAndUpdate(
    {
      $or: [
        {name: jobName, 
            startTime: {$lte: now}, endTime: {$gt: now}, status : 1, 'delete': {'$exists': false}, 
            lockedAt: null,  nextRunAt: {$lte: this._nextScanAt}, 
            disabled: { $ne: true }}
        ,
        {name: jobName, 
            startTime: {$lte: now}, endTime: {$gt: now}, status : 1,
            lockedAt: {$exists: false}, nextRunAt: {$lte: this._nextScanAt} ,'delete': {'$exists': false}, 
            disabled: { $ne: true }}
        ,
        {name: jobName, 
            startTime: {$lte: now}, endTime: {$gt: now}, status : 1,'delete': {'$exists': false}, 
            lockedAt: {$lte: lockDeadline}, 
            nextRunAt: {$lte: this._nextScanAt}, 
            disabled: { $ne: true }}
      ]
    },
    {
      $set:{'lockedAt': now}
    },
    {
      'returnOriginal': false
      ,'sort': {'priority': -1}
    },
    findAndUpdateResultWrapper(this, cb)
  );
};

/**
 *
 * @param agenda
 * @param cb
 * @return {Function}
 * @private
 */
function findJobsResultWrapper(agenda, cb) {
  return function (err, jobs) {
    if (jobs) {
      //query result can be array or one record
      if (Array.isArray(jobs)) {
        jobs = jobs.map(createJob.bind(null, agenda));
      } else {
        jobs = createJob(agenda, jobs);
      }
    }

    cb(err, jobs);
  };
}

function findAndUpdateResultWrapper(agenda, cb) {
  return function (err, job) {
    if(!job){
      cb(err, job);
      return;
    }
    job = job.value;

    if (job) {
      job = createJob(agenda, job);
    }

    cb(err, job);
  };
}

/**
 * Create Job object from data
 * @param {Object} agenda
 * @param {Object} jobData
 * @return {Job}
 * @private
 */
function createJob(agenda, jobData) {
  jobData.agenda = agenda;
  return new Job(jobData);
}

function unlockJobs(done) {
  function getJobId(j) {
    return j.attrs._id;
  }

  var jobIds = this._jobQueue.map(getJobId)
       .concat(this._runningJobs.map(getJobId));
  this._db.update({_id: { $in: jobIds } }, { $set: { lockedAt: null } }, {multi: true}, done);
}

function processJobs(extraJob) {
  if (!this._processInterval) {
    return;
  }

  var definitions = this._definitions,
    jobName,
    jobQueue = this._jobQueue,
    self = this;

  if (!extraJob) {
    for (jobName in definitions) {
      jobQueueFilling(jobName);
    }
  } else {
    // On the fly lock a job
    var now = new Date();
    self._db.findOneAndUpdate({ _id: extraJob.attrs._id, lockedAt: null, disabled: { $ne: true } }, 
      {
        $set: { lockedAt: now } 
      }, 
      {}, function(err, res){
      if (res && res.value) {
        jobQueue.unshift(extraJob);
        jobProcessing();
      }
    })
  }

  function jobQueueFilling(name) {
    var now = new Date();
    self._nextScanAt = new Date(now.valueOf() + self._processEvery);
    self._findAndLockNextJob(name, definitions[name], function (err, job) {
      if (err) {
        throw err;
      }
      if (job) {
        if( Array.isArray(job) ) {
          jobQueue = job.concat(jobQueue);
        } else {
          jobQueue.unshift(job);
        }

        jobQueueFilling(name);
        jobProcessing();
      }
    });
  }

  function jobProcessing() {
    if (!jobQueue.length) {
      return;
    }

    var now = new Date();

    var job = jobQueue.pop();
    var name = job.attrs.name;
    var jobDefinition = definitions[name];

    if (job.attrs.nextRunAt < now) {
      runOrRetry();
    } else {
      setTimeout(runOrRetry, job.attrs.nextRunAt - now);
    }

    function runOrRetry() {
      if (self._processInterval) {
        if (jobDefinition.concurrency > jobDefinition.running &&
            self._runningJobs.length < self._maxConcurrency) {

          self._runningJobs.push(job);
          jobDefinition.running++;

          job.run(processJobResult);
          jobProcessing();
        } else {
          // Put on top to run ASAP
          jobQueue.push(job);
        }
      }
    }
  }

  function processJobResult(err, job) {
    if(!job) { return;}
    var name = job.attrs.name;

    self._runningJobs.splice(self._runningJobs.indexOf(job), 1);
    definitions[name].running--;

    jobProcessing();
  }
}
