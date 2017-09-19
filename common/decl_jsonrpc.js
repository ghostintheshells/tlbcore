'use strict';
const _ = require('underscore');
const assert = require('assert');

module.exports = function(typereg) {

  let jsonrpcmsg = typereg.struct('jsonrpcmsg',
    ['method', 'string'],
    ['error', 'jsonstr'],
    ['id', 'int'],
    ['params', 'vector< jsonstr >'],
    ['result', 'jsonstr'],
    ['log_msgs', 'vector< string >']);
  jsonrpcmsg.omitTypeTag = true;
};
