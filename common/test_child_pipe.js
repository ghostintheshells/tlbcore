var _ = require('underscore');
var assert = require('assert');
var async = require('async');
var child_pipe = require('./child_pipe');
var logio = require('../web/logio');

describe('ChildPipe', function() {
  it('should work', function(done) {

    var cp1 = new child_pipe.ChildJsonPipe('python', ['common/child_pipe_test_slave.py'], {}, {nChildren: 3, verbose: 2});
    var cp2 = new child_pipe.ChildJsonPipe('node', ['common/child_pipe_test_slave.js'], {}, {nChildren: 2, verbose: 2});
    async.each([cp1, cp2], function(cp, done1) {
      cp.handshake(function(err) {
        if (err) return done(err);
        async.parallel([
          function(pdone) {
            async.each(_.range(10, 20), function(baseNum, cb) {
              cp.rpc('test1', [baseNum], function(err, v) {
                if (0) console.log(baseNum, v);
                assert.equal(err, null);
                assert.equal(v, baseNum + 1);
                cb();
              });
            }, function(err) {
              assert.equal(err, null);
              pdone();
            });
          },
          function(pdone) {
            cp.rpc('testerr', [], function(err, v) {
              assert.ok(err);
              assert.equal(err.message, 'testerr always raises this error');
              pdone();
            });
          },
          function(pdone) {
            cp.rpc('test2', ['abc', 'def', {'ghi': 'jkl', 'mno': {}}], function(err, v) {
              assert.equal(err, null);
              assert.deepEqual(v, [['abc', 'def', {'ghi': 'jkl', 'mno': {}}], 'foo'])
              pdone();
            });
          }
        ], function(err) {
          cp.close();
          done1();
        });
      });
    },
    done);
  });
});
