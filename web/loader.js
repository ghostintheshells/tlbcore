var _ = require('underscore');
var util = require('util');
var fs = require('fs');

exports.loadAndParse = loadAndParse;

var parsejs = require('./UglifyJS/lib/parse-js.js');


function loadAndParse(modname, cb) {
  
  var filename = require.resolve(modname);
  util.puts(filename);
  fs.readFile(filename, 'utf8', function(err, contents) {
    if (err) return cb(err);
    var parsed;
    try {
      parsed = parsejs.parse(contents, false, false);
    } catch(ex) {
      cb(ex);
      return;
    }
    cb(null, parsed);
  });
}
