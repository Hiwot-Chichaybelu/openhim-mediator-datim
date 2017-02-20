'use strict';

// load modules
const express = require('express');
const fs = require('fs');
const request = require('request');
const url = require('url');
const winston = require('winston');

const app = express();
winston.clear();
winston.add(winston.transports.Console, { timestamp: true, colorize: true });

// Config
var config; // this will vary depending on whats set in openhim-core
const apiConf = require('./config/config');
const mediatorConfig = require('./config/mediator');

const utils = require('openhim-mediator-utils');

const key = fs.readFileSync('tls/key.pem');
const cert = fs.readFileSync('tls/cert.pem');
const ca = fs.readFileSync('tls/ca.pem');

function setupAndStartApp() {
  app.post('*', (req, res) => {
    let query = url.parse(req.url, true).query;
    let adxAdapterID = null;
    if (query.adxAdapterID) {
      adxAdapterID = query.adxAdapterID;
      delete query.adxAdapterID;
    }
    if (config.upstreamAsync === true) {
      query.async = true;
    }
    let options = {
      url: config.upstreamURL,
      key: key,
      cert: cert,
      ca: ca,
      qs: query
    };
    winston.info(options.url);
    req.pipe(request.post(options, (err, upstreamRes, upstreamBody) => {

      if (err) {
        winston.error(err);
        return;
      }

      if (config.dhisAsync) {
        if (upstreamRes.statusCode === 200) {
          startPolling(adxAdapterID);
        }
      } else {
        forwardResponse(upstreamRes.statusCode, upstreamBody, adxAdapterID);
      }

      var urn = mediatorConfig.urn;
      var status = 'Successful';
      var response = {
        status: upstreamRes.statusCode,
        headers: upstreamRes.headers,
        body: upstreamBody,
        timestamp: new Date().getTime()
      };

      // construct returnObject to be returned
      var returnObject = {
        'x-mediator-urn': urn,
        'status': status,
        'response': response,
        'orchestrations': [],
        'properties': {}
      };

      // set content type header so that OpenHIM knows how to handle the response
      res.set('Content-Type', 'application/json+openhim');
      res.send(returnObject);

    }));
  });

  // setup express server
  let server = app.listen(3000, function () {
    let host = server.address().address;
    let port = server.address().port;
    winston.info(`DATIM mediator listening on http://${host}:${port}`);
    winston.info('Mediator started with config:', config);
  });
}

function forwardResponse(statusCode, body, adxAdapterID) {
  let options = {
    url: config.receiverURL + '/' + adxAdapterID,
    key: key,
    cert: cert,
    ca: ca,
    body: { code: statusCode, message: body },
    json: true
  };
  request.put(options, (err) => {
    if (err) {
      winston.error(err);
    }
    winston.info('Message received by receiver');
  });
}

function startPolling(adxAdapterID) {
  // setup task polling
  var statusInterval = setInterval(() => getImportStatus((err, body) => {
    if (err) {
      winston.error(err);
    }
    winston.info(`Received task status: ${JSON.stringify(body)}`);
    if (body[0].completed) {
      winston.info('Completed, stopping interval');
      clearInterval(statusInterval);
      forwardResponse(200, body[0], adxAdapterID);
    }
  }), config.pollingInterval);
}

function getImportStatus(callback) {
  if (!callback) { callback = () => {}; }

  let options = {
    url: config.upstreamTaskURL,
    key: key,
    cert: cert,
    ca: ca
  };
  request.get(options, (err, res, body) => {
    if (err) {
      return callback(err);
    }
    try {
      body = JSON.parse(body);
      callback(null, body);
    } catch (err) {
      callback(err);
    }
  });
}

// start-up procedure
if (apiConf.register) {
  utils.registerMediator(apiConf.api, mediatorConfig, (err) => {
    if (err) {
      winston.error('Failed to register this mediator, check your config');
      winston.error(err);
      process.exit(1);
    }
    apiConf.api.urn = mediatorConfig.urn;
    utils.fetchConfig(apiConf.api, (err, newConfig) => {
      winston.info('Received initial config:');
      winston.info(JSON.stringify(newConfig));
      config = newConfig;
      if (err) {
        winston.error('Failed to fetch initial config');
        winston.error(err);
        process.exit(1);
      } else {
        winston.info('Successfully registered mediator!');
        setupAndStartApp();
        let configEmitter = utils.activateHeartbeat(apiConf.api);
        configEmitter.on('config', (newConfig) => {
          winston.info('Received updated config:');
          winston.info(JSON.stringify(newConfig));
          config = newConfig;
        });
      }
    });
  });
} else {
  // default to config from mediator registration
  config = mediatorConfig.config;
  setupAndStartApp();
}
