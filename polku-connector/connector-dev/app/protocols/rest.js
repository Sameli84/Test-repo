"use strict";
/**
 * Module dependencies.
 */
const winston = require('../../logger.js');
const response = require('../lib/response');
const rp = require('request-promise');
/**
 * REST library.
 *
 * Handles API request composition and response error handling.
 */

/**
 * Returns promise reject with error.
 *
 * @param {Number} [code]
 * @param {String/Object} [msg]
 *   Error message.
 * @param {String} [reference]
 *   Additional info about the cause of the error.
 * @return {Promise}
 */
const promiseRejectWithError = function (code, msg, reference) {
    let err = new Error();
    err.httpStatusCode = code || 500;
    err.reference = reference;
    err.message = msg || 'Internal Server Error.';
    return Promise.reject(err);
};

/**
 * Sends data request. Configures authentication of the request.
 *
 * @param {Object} config
 * @param {Object} options
 * @param {String} path
 * @return {Promise}
 */

const getDataByOptions = async (config, options, path) => {
  console.log('inside restjs getdata',config)
    if (!config.url && !path) {
        return promiseRejectWithError(500, 'No url or path found in authConfig.');
    } else {
        // Compose query string.
        let queryString = '';
        if (options.query.length > 0) {
            queryString += '?';
            for (let i = 0; i < options.query.length; i++) {
                queryString += Object.keys(options.query[i])[0] + '=' + Object.values(options.query[i])[0];
                if (i !== (options.query.length - 1)) queryString += '&';
            }

            // Check whether the URL already contains query entries.
            let entries = [];
            for (let entry of new URL(options.url).searchParams.keys()) {
                entries.push(entry)
            }
            if (entries.length > 0) queryString = '&' + queryString.substr(1);

            // Attach query.
            options.url += queryString;
        }

        // Remove temporary query array.
        delete options.query;

        return rp(options).then(function (result) {
            return Promise.resolve(result);
        }).catch(function (err) {
            return Promise.reject(err);
        });
    }
};

/**
 * Handles erroneous response.
 *
 * @param {Object} config
 * @param {Error} err
 * @return {Promise}
 */
const handleError = async (config, err) => {
    winston.log('info', config.authConfig.template + ': Response with status code ' + err.statusCode);

    /** Connection error handling. */
    if (err.statusCode === 500
        || err.statusCode === 502
        || err.statusCode === 503
        || err.statusCode === 504
        || err.statusCode === 522
    ) {
        return promiseRejectWithError(err.statusCode, err.message);
    }

    // Execute onerror plugin function.
    for (let i = 0; i < config.plugins.length; i++) {
        if (!!config.plugins[i].onerror) {
            return await config.plugins[i].onerror(config, err);
        }
    }

    // Give up.
    return promiseRejectWithError(err.statusCode, 'Internal Server Error.');
};

/**
 * Initiates data requests.
 *
 * @param {Object} config
 * @param {String} pathArray
 *   Resource path, which will be included to the resource url.
 * @return {Array}
 */
const getData = async (config, pathArray) => {
    const items = [];
    for (let p = 0; p < pathArray.length; p++) {
        const item = await requestData(config, pathArray[p], p);
        if (item) items.push(item);
    }
    // console.log('inside restjs getdata items', items)
    return items;
};

/**
 * Parses body object from API response.
 *
 * @param {Object} response
 * @return {Object}
 */
const parseResBody = (config, response) => {
  // Execute dataManipulation plugin function.
  for (let i = 0; i < config.plugins.length; i++) {
    if (!!config.plugins[i].dataManipulation) {
        return config.plugins[i].dataManipulation(response.body);
    }
  }
  
  try {
    console.log(response.body)
      body = JSON.parse(response.body);
  } catch (err) {
      winston.log('error', 'Failed to parse response body.');
  }
  return body;
};

/**
 * Structures required information for data request.
 *
 * @param {Object} config
 * @param {String} path
 *   Resource path, which will be included to the request.
 * @param {Number} index
 * @return {Promise}
 */
const requestData = async (config, path, index) => {
  console.log('inside restjs reqdata config.parameters',config.parameters)
    // Initialize request options.
    let method = 'GET';
    let options = {
        method: method,
        url: path.includes('://') ? path : config.authConfig.url + path,
        headers: config.authConfig.headers || {},
        resolveWithFullResponse: true,
        query: []
    };

    // Define start and end query properties
    if (config.generalConfig.query) {
        if (config.generalConfig.query.start) {
            options.query.push({
                [config.generalConfig.query.start]: config.parameters.start
            });
        }
        if (config.generalConfig.query.end) {
            options.query.push({
                [config.generalConfig.query.end]: config.parameters.end
            });
        }
        if (config.generalConfig.query.properties) {
            for (let property in config.generalConfig.query.properties) {
                if (Object.hasOwnProperty.call(config.generalConfig.query.properties, property)) {
                    options.query.push(config.generalConfig.query.properties[property]);
                }
            }
        }
    }

    // Execute request plugin function.
    for (let i = 0; i < config.plugins.length; i++) {
        if (!!config.plugins[i].request) {
            options = await config.plugins[i].request(config, options);
        }
    }

    /** First attempt */
    return getDataByOptions(config.authConfig, options, path).then(function (result) {
        // Handle received data.
        if (result !== null) return response.handleData(config, path, index, parseResBody(config, result));
        // Handle connection timed out.
        return promiseRejectWithError(522, 'Connection timed out.');
    }).then(function (result) {
        // Return received data.
        return Promise.resolve(result);
    }).catch(function (err) {
        if (Object.hasOwnProperty.call(err, 'statusCode')) {
            if (err.statusCode === 404 || err.statusCode === 400) {
                return Promise.resolve([]);
            }
        }
        return handleError(config, err).then(function () {
            /** Second attempt */
            // If error handler recovers from the error, another attempt is initiated.
            return getData(config, path);
        }).then(function (result) {
            // Handle received data.
            if (result !== null) return response.handleData(config, path, index, parseResBody(result));
            return promiseRejectWithError(522, 'Connection timed out.');
        }).then(function (result) {
            // Return received data.
            return Promise.resolve(result);
        }).catch(function (err) {
            return Promise.reject(err);
        });
    });
};

/**
 * Expose library functions.
 */
module.exports = {
    getData,
    promiseRejectWithError
};
