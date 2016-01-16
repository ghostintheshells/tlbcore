
module.exports = function(typereg) {

  typereg.scanCFunctions('Dv operator+ (Dv a, Dv b);\n' +
                         'Dv operator- (Dv a, Dv b);\n' +
                         'Dv operator* (Dv a, Dv b);\n' +
                         'Dv operator/ (Dv a, Dv b);\n' +
                         'Dv sin (Dv a);\n' +
                         'Dv cos (Dv a);\n' +
                         'Dv tanh (Dv a);\n' +
                         'Dv relu (Dv a);\n');

  /*
    Define a standard learning problem. This bundles together the following:
      - a vector of inputs and outputs
      - parameters for a prediction function
      - the prediction function
      - the loss function

    Call as
      lp = typereg.learningProblem(paramTypename, inputTypename, outputTypename)
    to define the types. It returns a type, which in addition to the usual things you can do with a type, allows you to set
      lp.lossFunc = function(f) { f('return sqrt(actual - pred);'); }
      lp.regularizerFunc = function(f) { f('return sqr(theta.a1) + sqr(theta.a2);'); }
    and
      lp.predictFunc = function(f) { f('return something(theta, input);'); }

    Then when you instantiate the type, you can call
      problem.sgdStep(learningRate, minibatchSize, verbose);

    to improve the parameters. It does stochastic gradient descent, which means it takes the
    gradient of the loss function WRT the parameters, evaluated over (minibatchSize) randomly selected
    input-output pairs, and moves the parameters in the direction to minimize the loss (according to learningRate).

    After a large number of steps, you can retrieve the parameters with
      problem.theta
    
  */

  typereg.learningProblem = function(paramTypename, inputTypename, outputTypename) {
    var typereg = this;
    if (!(paramTypename in typereg.types)) throw ('Type ' + paramTypename + ' not defined yet');
    if (!(inputTypename in typereg.types)) throw ('Type ' + inputTypename + ' not defined yet');
    if (!(outputTypename in typereg.types)) throw ('Type ' + outputTypename + ' not defined yet');
    
    var paramType = typereg.getType(paramTypename);
    var inputType = typereg.getType(inputTypename);
    var outputType = typereg.getType(outputTypename);
    var problemTypename = 'LearningProblem<' + paramTypename + ',' + inputTypename + ',' + outputTypename + '>';

    var type = typereg.template(problemTypename);
    
    type.addJsWrapHeaderInclude('tlbcore/dv/dv_jsWrap.h');
    type.addHeaderInclude('tlbcore/dv/optimize.h');
    type.noSerialize = true;
    type.noPacket = true;

    type.addJswrapMethod(function(f) {
      var type = this;
      f.emitJsMethod('addPair', function() {
        f.emitArgSwitch([{
          args: [inputTypename, outputTypename], code: function(f) {
            f('thisObj->it->addPair(a0, a1);');
          }
        }]);
      });

      f.emitJsMethod('predict', function() {
        f.emitArgSwitch([{
          args: [inputTypename], code: function(f) {
            f('' + outputTypename + ' ret = thisObj->it->predict(a0);');
            f('args.GetReturnValue().Set(' + outputType.getCppToJsExpr('ret') + ');');
          }
        }]);
      });

      f.emitJsMethod('loss', function() {
        f.emitArgSwitch([{
          args: [outputTypename, outputTypename], code: function(f) {
            f('Dv ret = thisObj->it->loss(a0, a1);');
            f('args.GetReturnValue().Set(convDvToJs(isolate, ret));');
          }
        }]);
      });

      f.emitJsMethod('regularizer', function() {
        f.emitArgSwitch([{
          args: [], code: function(f) {
            f('Dv ret = thisObj->it->regularizer();');
            f('args.GetReturnValue().Set(convDvToJs(isolate, ret));');
          }
        }]);
      });

      f.emitJsMethod('sgdStep', function() {
        f.emitArgSwitch([{
          args: ['double', 'double'], code: function(f) {
            f('double loss = thisObj->it->sgdStep(a0, a1);');
            f('args.GetReturnValue().Set(Local<Value>(Number::New(isolate, loss)));');
          }
        }]);
      });

      f.emitJsMethod('lbfgs', function() {
        f.emitArgSwitch([{
          args: [], code: function(f) {
            f('double loss = thisObj->it->lbfgs();');
            f('args.GetReturnValue().Set(Local<Value>(Number::New(isolate, loss)));');
          }
        }]);
      });
    });

    type.addJswrapAccessor(function(f) {
      f.emitJsAccessors('theta', {
        get: 'args.GetReturnValue().Set(' + paramType.getCppToJsExpr('thisObj->it->theta', 'thisObj->it') + ');'
      });
      f.emitJsAccessors('verbose', {
        get: 'args.GetReturnValue().Set(' + typereg.getType('int').getCppToJsExpr('thisObj->it->verbose') + ');',
        set: 'thisObj->it->verbose = ' + typereg.getType('int').getJsToCppExpr('value') + ';'
      });
      f.emitJsAccessors('regularization', {
        get: 'args.GetReturnValue().Set(' + typereg.getType('double').getCppToJsExpr('thisObj->it->regularization') + ');',
        set: 'thisObj->it->regularization = ' + typereg.getType('double').getJsToCppExpr('value') + ';'
      });
    });

    type.addHostCode(function(f) {
      if (type.preLossPredict) {
        type.preLossPredict(f);
      }
      if (type.lossFunc) {
        f('template<>');
        f('Dv LearningProblem<' + paramTypename + ',' + inputTypename + ',' + outputTypename + '>::loss(' + outputTypename + ' const &pred, ' + outputTypename + ' const &actual) {');
        type.lossFunc(f);
        f('}');
      }

      if (type.regularizerFunc) {
        f('template<>');
        f('Dv LearningProblem<' + paramTypename + ',' + inputTypename + ',' + outputTypename + '>::regularizer() {');
        type.regularizerFunc(f);
        f('}');
      }
      
      if (type.predictFunc) {
        f('template<>');
        f('' + outputTypename + ' LearningProblem<' + paramTypename + ',' + inputTypename + ',' + outputTypename + '>::predict(' + inputTypename + ' const &input) {');
        type.predictFunc(f);
        f('}');
      }
    });
    

    return type;
  };

}
