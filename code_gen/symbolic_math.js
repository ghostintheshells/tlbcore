/*
  A way of building up arithmetic formulas in JS that can be emitted as C++ code,
  or directly evaluated.
*/
'use strict';
const _ = require('underscore');
const util = require('util');
const cgen = require('./cgen');
const assert = require('assert');
const crypto = require('crypto');

exports.defop = defop;
exports.SymbolicContext = SymbolicContext;

let optimize = true;


/*
  defop(retType, op,  argTypes..., {
    c: (x, y) => {
      return `C++ code to generate results, given that x, y are C++ expressions for the arguments`;
    },
    js: ... like above, for javascript code
    deriv: (wrt, x, y) => {
      return SymbolicNodes for the derivative of the value of this op WRT wrt.
      Contents of this.args are included for your convenience after wrt.
    },
    gradient: (deps, g, x, y) => {
      Given g as the gradient of the value of this node, backpropagate to the arguments.
      For +, this would be:
        x.addGradient(deps, g);
        y.addGradient(deps, g);
      For *, this would be:
        a.addGradient(deps, c.E('*', g, b));
        b.addGradient(deps, c.E('*', g, a));
    },
  });
*/
let defops = {};
exports.defops = defops;
function defop(retType, op, ...argTypes) {
  let impl = argTypes.pop();

  if (!defops[op]) defops[op] = [];
  defops[op].push({
    retType,
    argTypes,
    impl,
    op,
  });
}


function simpleHash(s) {
  let h = crypto.createHmac('sha1', 'key');
  h.update(s);
  return h.digest('hex').substr(0, 16);
}


function SymbolicContext(typereg, name, outArgs, updateArgs, inArgs) {
  let c = this;
  c.typereg = typereg;
  c.name = name;

  c.langs = {
    c: true,
    js: true,
  };
  c.cses = {};
  c.writes = {};
  c.reads = {};
  c.preCode = [];
  c.postCode = [];
  c.preDefn = [];
  c.arrayBuilder = {};
  c.lets = {};

  c.outArgs = _.map(outArgs, ([name, typeName, opt]) => {
    if (!opt) opt = {};
    let t = typereg.getType(typeName, true);
    if (!t) throw new Error(`Unknown type ${typeName}`);
    c.lets[name] = new SymbolicRef(c, t, name, 'out', opt);
    return [name, t, opt];
  });

  c.updateArgs = _.map(updateArgs, ([name, typeName, opt]) => {
    if (!opt) opt = {};
    let t = typereg.getType(typeName, true);
    if (!t) throw new Error(`Unknown type ${typeName}`);
    c.lets[name] = new SymbolicRef(c, t, name, 'update', opt);
    return [name, t, opt];
  });

  c.inArgs = _.map(inArgs, ([name, typeName, opt]) => {
    if (!opt) opt = {};
    let t = typereg.getType(typeName, true);
    if (!t) throw new Error(`Unknown type ${typeName}`);
    c.lets[name] = new SymbolicRef(c, t, name, 'in', opt);
    return [name, t, opt];
  });

  c.registerWrapper();
  c.defop = defop;
}

SymbolicContext.prototype.registerWrapper = function() {
  let c = this;

  if (c.langs.c) {
    c.typereg.addWrapFunction(c.getSignature(), '', c.name, '', 'void', c.collectArgs((argname, argType, dir) => {
      if (dir === 'out') {
        return {
          typename: argType.typename,
          passing: '&',
        };
      }
      else if (dir === 'update') {
        return [{
          typename: argType.typename,
          passing: '&',
        }, {
          typename: argType.typename,
          passing: 'const &',
        }];
      }
      else if (dir === 'in') {
        return {
          typename: argType.typename,
          passing: 'const &',
        };
      }
    }));
  }
};

/*
  For each arg in order, call argFunc(name, type, dir, opt) where dir is 'out', 'update', or 'in'.
*/
SymbolicContext.prototype.collectArgs = function(argFunc) {
  let c = this;
  return _.flatten([
    _.map(c.outArgs, ([name, t, opt]) => {
      return argFunc(name, t, 'out', opt);
    }),
    _.map(c.updateArgs, ([name, t, opt]) => {
      return argFunc(name, t, 'update', opt);
    }),
    _.map(c.inArgs, ([name, t, opt]) => {
      return argFunc(name, t, 'in', opt);
    })
  ]);
};

SymbolicContext.prototype.getAllTypes = function() {
  return _.uniq(this.collectArgs((name, type, dir) => {
    return type;
  }));
};

SymbolicContext.prototype.getSignature = function(lang) {
  let c = this;
  if (lang === 'c') {
    return `
      void ${c.name}(${
        c.collectArgs((argName, argType, dir) => {
          if (dir === 'out') {
            return `${argType.typename} &${argName}`;
          }
          else if (dir === 'update') {
            return [`${argType.typename} &${argName}Next`, `${argType.typename} const &${argName}Prev`];
          }
          else if (dir === 'in') {
            return `${argType.typename} const &${argName}`;
          }
        }).join(', ')
      })
    `;
  }
  else if (lang === 'js') {
    return `
      function ${c.name}(${
        c.collectArgs((argName, argType, dir) => {
          if (dir === 'out') {
            return argName;
          }
          else if (dir === 'update') {
            return [`${argName}Next`, `${argName}Prev`];
          }
          else if (dir === 'in') {
            return argName;
          }
        }).join(', ')
      })
    `;
  }
};

SymbolicContext.prototype.emitDecl = function(lang, f) {
  let c = this;
  if (lang === 'c') {
    f(c.getSignature(lang) + ';');
  }
};


SymbolicContext.prototype.emitDefn = function(lang, f) {
  let c = this;
  if (lang === 'js') {
    f(`exports.${c.name} = ${c.name};`);
  }
  _.each(c.preDefn, (code) => { code(lang, f); });
  f(`${c.getSignature(lang)} {`);
  _.each(c.preCode, (code) => { code(lang, f); });
  c.emitCode(lang, f);
  _.each(c.postCode, (code) => { code(lang, f); });
  f(`}
  `);
};



SymbolicContext.prototype.findop = function(op, argTypes) {
  let c = this;
  let ops = defops[op];
  if (ops) {
    let opInfo = _.find(ops, (it) => {
      for (let argi=0; argi < it.argTypes.length; argi++) {
        if (it.argTypes[argi] === '...') return true;
        if (it.argTypes[argi] === 'ANY') continue;
        if (argTypes[argi] === 'UNKNOWN') continue;
        let at = c.typereg.getType(it.argTypes[argi]);
        if (at === argTypes[argi]) continue;
        return false;
      }
      return true;
    });
    if (opInfo) {
      return opInfo;
    }
  }
  return null;
};


SymbolicContext.prototype.dedup = function(e) {
  let c = this;
  assert.strictEqual(e.c, c);
  while (e.opInfo && e.opInfo.impl.replace) {
    let newe = e.opInfo.impl.replace.call(e, c, ...e.args);
    if (!newe) break;
    e = newe;
  }
  assert.strictEqual(e.c, c);
  let cse = c.cses[e.cseKey];
  if (cse) return cse;
  c.cses[e.cseKey] = e;
  return e;
};

SymbolicContext.prototype.ref = function(name) {
  let c = this;
  let found = c.lets[name];
  if (found) return found;
  throw new Error(`ref(${name}): no such variable`);
};

SymbolicContext.prototype.isNode = function(a) {
  let c = this;
  if (a instanceof SymbolicExpr || a instanceof SymbolicRead || a instanceof SymbolicRef || a instanceof SymbolicConst) {
    if (a.c !== c) throw new Error(`Wrong context for ${a} context=${a.c}, expected ${c}`);
    return true;
  }
  return false;
};

SymbolicContext.prototype.assertNode = function(a) {
  let c = this;
  if (!c.isNode(a)) {
    throw new Error(`Not a node: ${a}`);
  }
  return a;
};

SymbolicContext.prototype.W = function(dst, value) {
  let c = this;
  if (0) value.printName = name;
  c.assertNode(dst);
  c.assertNode(value);
  let e = c.dedup(new SymbolicWrite(
    c,
    value.type,
    dst,
    value));
  c.writes[e.cseKey] = e;
  return value;
};

SymbolicContext.prototype.Wa = function(dst, value) {
  let c = this;

  c.assertNode(dst);
  c.assertNode(value);

  let index = dst.arrayIndex || 0;
  dst.arrayIndex = index + 1;

  let e = c.dedup(new SymbolicWrite(
    c,
    value.type,
    c.E(`[${index}]`, dst),
    value));
  c.writes[e.cseKey] = e;
  return value;
};

SymbolicContext.prototype.C = function(type, value) {
  let c = this;
  return c.dedup(new SymbolicConst(c, c.typereg.getType(type), value));
};

SymbolicContext.prototype.Ci = function(value) { return this.C('int', value); };
SymbolicContext.prototype.Cd = function(value) { return this.C('double', value); };
SymbolicContext.prototype.Cm33 = function(value) { return this.C('Mat33', value); };
SymbolicContext.prototype.Cm44 = function(value) { return this.C('Mat44', value); };
SymbolicContext.prototype.Cv3 = function(value) { return this.C('Vec3', value); };
SymbolicContext.prototype.Cv4 = function(value) { return this.C('Vec4', value); };


SymbolicContext.prototype.E = function(op, ...args) {
  let c = this;
  let args2 = _.map(args, (arg, argi) => {
    if (arg instanceof SymbolicExpr || arg instanceof SymbolicRead || arg instanceof SymbolicRef || arg instanceof SymbolicConst) {
      assert.strictEqual(arg.c, c);
      return arg;
    }
    else if (_.isNumber(arg)) {
      return c.C('double', arg);
    }
    else {
      throw new Error(`Unknown arg type for op ${op}, args[${argi}] in ${util.inspect(args)}`);
    }
  });
  return c.dedup(new SymbolicExpr(c, op, args2));
};


SymbolicContext.prototype.T = function(arg, t) {
  // Dereference any reads
  while (arg.isRead()) arg = arg.ref;

  if (arg.materializeMember) {
    arg = arg.materializeMember(t);
  }
  return arg;
};

SymbolicContext.prototype.structref = function(memberName, a, autoCreateType) {
  let c = this;
  if (!a.isAddress) throw new Error(`Not dereferencable: ${util.inspect(a)}`);

  let t = a.type;
  if (!t) throw new Error(`Unknown type for ${util.inspect(a)}`);
  if (!t.nameToType) throw new Error(`Not dererenceable: ${a.t.typename}`);
  let retType = t.nameToType[memberName];
  if (!retType && t.autoCreate) {
    t.add(memberName, autoCreateType);
  }
  return c.E(`.${memberName}`, a);
};

SymbolicContext.prototype.matrixElem = function(matrix, rowi, coli) {
  let c = this;
  assert.strictEqual(matrix.c, c);
  if (matrix instanceof SymbolicExpr && matrix.op === 'Mat44') {
    return matrix.args[rowi + coli*4];
  }
  else {
    return c.E(`(${rowi},${coli})`, matrix);
  }
};

SymbolicContext.prototype.emitCode = function(lang, f) {
  let c = this;
  let deps = c.getDeps();
  let availCses = {};
  _.each(deps.writes, (a) => {
    a.emitCode(lang, deps, f, availCses);
  });
};

// ----------------------------------------------------------------------

SymbolicContext.prototype.withGradients = function(newName) {
  let c = this;
  let ctx = {
    newName,
    copied: new Map(),
  };

  let newOutArgs = _.clone(c.outArgs);
  let newUpdateArgs = _.clone(c.updateArgs);
  let newInArgs = _.clone(c.inArgs);
  _.each(c.outArgs, function([name, type, opt]) {
    if (!opt.noGrad) {
      newInArgs.push([`${name}Grad`, type, _.extend({}, opt, {isGrad: true})]);
    }
  });
  _.each(c.updateArgs, function([name, type, opt]) {
    if (!opt.noGrad) {
      newUpdateArgs.push([`${name}Grad`, type, _.extend({}, opt, {isGrad: true})]);
    }
  });
  _.each(c.inArgs, function([name, type, opt]) {
    if (!opt.noGrad) {
      newOutArgs.push([`${name}Grad`, type, _.extend({}, opt, {isGrad: true})]);
    }
  });

  let c2 = c.typereg.addSymbolic(newName, newOutArgs, newUpdateArgs, newInArgs);
  ctx.c = c2;
  c2.preCode = c.preCode;
  c2.postCode = c.postCode;
  c2.preDefn = c.preDefn;
  c2.writes = _.object(_.map(c.writes, (wr) => {
    let wr2 = wr.deepCopy(ctx);
    return [wr2.cseKey, wr2];
  }));
  c2.reads = _.object(_.map(c.reads, (rd) => {
    let rd2 = rd.deepCopy(ctx);
    return [rd2.cseKey, rd2];
  }));

  c2.addGradients();
  return c2;
};

// ----------------------------------------------------------------------

function SymbolicNode() {
  let e = this;
}

function SymbolicWrite(c, type, ref, value) {
  let e = this;
  e.c = c;
  assert.ok(type.typename);
  e.type = type;
  if (!ref.isAddress) {
    throw new Error(`Write to ${util.inspect(ref)}: not an address`);
  }
  e.ref = ref;
  if (value.isAddress) {
    value = c.dedup(new SymbolicRead(c, value.type, value));
  }
  e.value = value;
  e.cseKey = '_w' + simpleHash(`{e.type.typename},${e.ref.cseKey},${e.value.cseKey}`);
}
SymbolicWrite.prototype = Object.create(SymbolicNode.prototype);
SymbolicWrite.prototype.isWrite = function() { return true; }

function SymbolicRead(c, type, ref) {
  let e = this;
  e.c = c;
  assert.ok(type.typename);
  e.type = type;
  assert.ok(ref.isAddress);
  e.ref = ref;
  e.cseKey = '_r' + simpleHash(`${e.type.typename},${e.ref.cseKey}`);
}
SymbolicRead.prototype = Object.create(SymbolicNode.prototype);
SymbolicRead.prototype.isRead = function() { return true; }

function SymbolicRef(c, type, name, dir, opt) {
  let e = this;
  e.c = c;
  assert.ok(type.typename);
  e.type = type;
  assert.ok(_.isString(name));
  e.name = name;
  assert.ok(dir === 'in' || dir === 'out' || dir === 'update');
  e.dir = dir;
  e.isAddress = true;
  e.opt = opt;
  e.cseKey = '_v' + simpleHash(`${e.type.typename},${e.name},${e.dir},${e.isAddress},${JSON.stringify(e.opt)}`);
}
SymbolicRef.prototype = Object.create(SymbolicNode.prototype);
SymbolicRef.prototype.isRef = function() { return true; }

function SymbolicConst(c, type, value) {
  let e = this;
  e.c = c;
  assert.ok(type.typename);
  e.type = type;
  e.value = value;
  e.cseKey = '_c' + simpleHash(`${e.type.typename},${JSON.stringify(e.value)}`);
}
SymbolicConst.prototype = Object.create(SymbolicNode.prototype);

function SymbolicExpr(c, op, args) {
  let e = this;
  e.c = c;
  e.op = op;

  if (op.startsWith('.') && args.length === 1) {
    let memberName = op.substring(1);

    let arg = args[0];
    /*
      This fixes the situation where we have foo(os.bar), where foo(x) has a .replace method that expands into x.buz.
      In that case, we added the SymbolicRead node too early, and we want to bypass it and be back in address mode again.
    */
    if (arg instanceof SymbolicRead) {
      arg = arg.ref;
    }
    e.args = [arg];
    let t = arg.type;
    if (!t) throw new Error(`Unknown type for ${util.inspect(arg)}`);
    if (!t.nameToType) throw new Error(`No member ${memberName} in ${t.typename}, which isn't even a struct`);

    let retType = t.nameToType[memberName];
    if (!retType && arg.type.autoCreate) {
      retType = 'UNKNOWN';
      e.materializeMember = (t) => {
        arg.type.add(memberName, c.typereg.getType(t));
        return c.E(op, arg);
      };
    }

    e.type = retType;
    e.isStructref = true;
    e.memberName = memberName;
    e.opInfo = {
      impl: {
        imm: function(a) {
          return a[memberName];
        },
        c: function(a, b) {
          return `${a}.${memberName}`;
        },
        js: function(a, b) {
          return `${a}.${memberName}`;
        },
        deriv: function(c, wrt, a) {
          return c.E(op, c.D(wrt, a));
        },
        gradient: function(c, deps, g, a) {

          // WRITEME?
        },
        replace: function(c, a) {
          if (a.isZero()) {
            return c.C(this.type, 0);
          }
        },
      },
    };
    e.isAddress = arg.isAddress;
    e.cseKey = '_e' + simpleHash(`${e.type ? e.type.typename : '?'},${e.op},${_.map(e.args, (arg) => arg.cseKey).join(',')}`);
    return;
  }

  if (op.startsWith('[') && op.endsWith(']') && args.length === 1) {
    let index = parseInt(op.substring(1, op.length-1));
    let t = args[0].type;
    if (!t) throw new Error(`Unknown type for ${args[0]}`);
    let retType = null;
    if (t.templateName === 'vector' ||
      t.templateName === 'arma::Col' || t.templateName === 'arma::Col::fixed' ||
      t.templateName === 'arma::Row' || t.templateName === 'arma::Row::fixed' ||
      t.templateName === 'arma::Mat' || t.templateName === 'arma::Mat::fixed') {
      retType = t.templateArgTypes[0];
    }
    if (!retType) throw new Error(`Can't index into ${t.type.typename}`);

    let arg = args[0];
    if (arg instanceof SymbolicRead) {
      arg = arg.ref;
    }
    e.args = [arg];

    e.type = retType;
    e.isStructref = true;
    e.opInfo = {
      impl: {
        imm: function(a) {
          return a[index];
        },
        c: function(a, b) {
          return `${a}[${index}]`;
        },
        js: function(a, b) {
          return `${a}[${index}]`;
        },
        deriv: function(c, wrt, a) {
          return c.E(op, c.D(wrt, a));
        },
        gradient: function(c, deps, g, a) {
          // WRITEME?
        },
      },
    };
    e.isAddress = arg.isAddress;
    e.cseKey = '_e' + simpleHash(`${e.type.typename},${e.op},${_.map(e.args, (arg) => arg.cseKey).join(',')}`);
    return;
  }

  let opInfo = c.findop(op, _.map(args, (a) => a.type));
  if (opInfo) {
    e.args = _.map(args, (a) => {
      if (a.isAddress && a.type !== 'UNKNOWN') {
        return c.dedup(new SymbolicRead(c, a.type, a));
      } else {
        return a;
      }
    });
    e.type = c.typereg.getType(opInfo.retType);
    e.isStructref = true;
    e.opInfo = opInfo;
    e.isAddress = false;
    e.cseKey = '_e' + simpleHash(`${e.type.typename},${e.op},${_.map(e.args, (arg) => arg.cseKey).join(',')}`);
    return;
  }

  let cls = c.typereg.getType(op);
  if (cls) {
    e.args = _.map(args, (a) => {
      if (a.isAddress && a.type !== 'UNKNOWN') {
        return c.dedup(new SymbolicRead(c, a.type, a));
      } else {
        return a;
      }
    });
    e.type = cls;
    e.isStructref = false;
    e.opInfo = {
      impl: {
        c: function(...args) {
          if (this.type.templateName === 'arma::Col' || this.type.templateName === 'arma::Col::fixed' ||
              this.type.templateName === 'arma::Row' || this.type.templateName === 'arma::Row::fixed' ||
              this.type.templateName === 'arma::Mat' || this.type.templateName === 'arma::Mat::fixed') {
            return `${this.type.typename}{${_.map(args, (a) => `${a}`).join(', ')}}`;
          } else {
            return `${this.type.typename}(${_.map(args, (a) => `${a}`).join(', ')})`;
          }
        },
        js: function(...args) {
          if (this.type.templateName === 'arma::Col' || this.type.templateName === 'arma::Col::fixed' ||
              this.type.templateName === 'arma::Row' || this.type.templateName === 'arma::Row::fixed' ||
              this.type.templateName === 'arma::Mat' || this.type.templateName === 'arma::Mat::fixed') {
            return `Float64Array.of(${_.map(args, (a) => `${a}`).join(', ')})`;
          }
          return `{__type:'${this.type.jsTypename}', ${(
            _.map(this.type.orderedNames, (name, argi) => {
              return `${name}:${args[argi]}`;
            }).join(', ')
          )}}`;
        },
        deriv: function(c, wrt, ...args) {
          return c.E(op, ..._.map(args, (a) => c.D(a, wrt)));
        },
        gradient: function(c, deps, g, ...args) {
          // FIXME
        }
      },
    };
    e.isAddress = false;
    e.cseKey = '_e' + simpleHash(`${e.type.typename},${e.op},${_.map(e.args, (arg) => arg.cseKey).join(',')}`);
    return;
  }

  throw new Error(`No op named ${op} for types (${
    _.map(args, (a) => a.type && a.type.typename).join(', ')
  })`);

}
SymbolicExpr.prototype = Object.create(SymbolicNode.prototype);


// ----------------------------------------------------------------------

SymbolicNode.prototype.isZero = function() {
  return false;
};
SymbolicNode.prototype.isOne = function() {
  return false;
};
SymbolicNode.prototype.isConst = function() {
  return false;
};
SymbolicNode.prototype.isRead = function() {
  return false;
};
SymbolicNode.prototype.isWrite = function() {
  return false;
};
SymbolicNode.prototype.isRef = function() {
  return false;
};

SymbolicConst.prototype.isZero = function() {
  let e = this;
  if (e.value === 0) return true;
  //if (e.type === 'double' && e.value === 0) return true;
  //if (e.type === 'Mat44' && e.value === 0) return true;
  return false;
};
SymbolicConst.prototype.isOne = function() {
  let e = this;
  if (e.value === 1) return true;
  //if (e.type === 'double' && e.value === 1) return true;
  //if (e.type === 'Mat44' && e.value === 1) return true;
  return false;
};
SymbolicConst.prototype.isConst = function() {
  return true;
};

SymbolicExpr.prototype.isZero = function() {
  let e = this;
  let c = e.c;
  if (e.opInfo.impl.isZero) {
    return e.opInfo.impl.isZero.apply(e, [c].concat(e.args));
  }
  return false;
};
SymbolicExpr.prototype.isOne = function() {
  let e = this;
  let c = e.c;
  if (e.opInfo.impl.isOne) {
    return e.opInfo.impl.isOne.apply(e, [c].concat(e.args));
  }
  return false;
};

// ----------------------------------------------------------------------

SymbolicNode.prototype.deepCopy = function(ctx) {
  let e = this;
  let copy = ctx.copied.get(e.cseKey);
  if (!copy) {
    copy = e.deepCopy1(ctx);
    ctx.copied.set(e.cseKey, copy);
  }
  return copy;
};

SymbolicConst.prototype.deepCopy1 = function(ctx) {
  let e = this;
  return new SymbolicConst(ctx.c, e.type, e.value);
};

SymbolicRef.prototype.deepCopy1 = function(ctx) {
  let e = this;
  return new SymbolicRef(ctx.c, e.type, e.name, e.dir, e.opt);
};

SymbolicWrite.prototype.deepCopy1 = function(ctx) {
  let e = this;
  return new SymbolicWrite(ctx.c, e.type, e.ref.deepCopy(ctx), e.value.deepCopy(ctx));
};

SymbolicRead.prototype.deepCopy1 = function(ctx) {
  let e = this;
  return new SymbolicRead(ctx.c, e.type, e.ref.deepCopy(ctx));
};

SymbolicExpr.prototype.deepCopy1 = function(ctx) {
  let e = this;
  return new SymbolicExpr(ctx.c, e.op, _.map(e.args, (arg) => {
    return arg.deepCopy(ctx);
  }));
};

// ----------------------------------------------------------------------

SymbolicContext.prototype.getDeps = function() {
  let c = this;
  let deps = {
    fwd: {},
    rev: {},
    uses: {},
    writes: {},
    reads: {},
    gradients: {},
    totGradients: {},
    inOrder: [],
  };
  _.each(c.writes, (a) => {
    a.addDeps(deps);
  });
  return deps;
};

SymbolicNode.prototype.addDeps = function(deps) {
  let e = this;
  deps.uses[e.cseKey] = (deps.uses[e.cseKey] || 0) + 1;
  if (!deps.fwd[e.cseKey]) {
    deps.fwd[e.cseKey] = [];
    deps.gradients[e.cseKey] = [];
    deps.inOrder.push(e);
  }
};

SymbolicWrite.prototype.addDeps = function(deps) {
  let e = this;
  deps.writes[e.cseKey] = e;
  deps.uses[e.cseKey] = (deps.uses[e.cseKey] || 0) + 1;
  if (!deps.fwd[e.cseKey]) {
    deps.fwd[e.cseKey] = [e.value];
    deps.gradients[e.cseKey] = [];
    if (!deps.rev[e.value.cseKey]) deps.rev[e.value.cseKey] = [];
    deps.rev[e.value.cseKey].push(e);
    e.value.addDeps(deps);
    e.ref.addDeps(deps);
    deps.inOrder.push(e);
  }
};

SymbolicRead.prototype.addDeps = function(deps) {
  let e = this;
  deps.reads[e.cseKey] = e;
  deps.uses[e.cseKey] = (deps.uses[e.cseKey] || 0) + 1;
  if (!deps.fwd[e.cseKey]) {
    deps.fwd[e.cseKey] = [e.ref];
    deps.gradients[e.cseKey] = [];
    if (!deps.rev[e.ref.cseKey]) deps.rev[e.ref.cseKey] = [];
    deps.rev[e.ref.cseKey].push(e);
    e.ref.addDeps(deps);
    deps.inOrder.push(e);
  }
};

SymbolicRef.prototype.addDeps = function(deps) {
  let e = this;
  deps.uses[e.cseKey] = (deps.uses[e.cseKey] || 0) + 1;
  if (!deps.fwd[e.cseKey]) {
    deps.fwd[e.cseKey] = [];
    deps.gradients[e.cseKey] = [];
    deps.inOrder.push(e);
  }
};

SymbolicExpr.prototype.addDeps = function(deps) {
  let e = this;
  deps.uses[e.cseKey] = (deps.uses[e.cseKey] || 0) + 1;
  if (!deps.fwd[e.cseKey]) {
    deps.fwd[e.cseKey] = _.clone(e.args);
    _.each(e.args, (arg) => {
      if (!deps.rev[arg.cseKey]) deps.rev[arg.cseKey] = [];
      deps.rev[arg.cseKey].push(e);
    });
    _.each(e.args, (arg) => {
      arg.addDeps(deps);
    });
    deps.inOrder.push(e);
    deps.gradients[e.cseKey] = [];
  }
};

// ----------------------------------------------------------------------

SymbolicNode.prototype.inspect = function(depth, opts) {
  return `${this.cseKey}`;
};

SymbolicWrite.prototype.inspect = function(depth, opts) {
  return `${this.cseKey}=write(${util.inspect(this.ref, depth+1, opts)}, ${this.value.cseKey})`;
};

SymbolicRef.prototype.inspect = function(depth, opts) {
  return `${this.cseKey}=ref(${this.name})`;
};

SymbolicExpr.prototype.inspect = function(depth, opts) {
  return `${this.cseKey}=${this.op}(${_.map(this.args, (a) => a.cseKey).join(' ')})`;
};

SymbolicConst.prototype.inspect = function(depth, opts) {
  return `${this.cseKey}=${this.type.typename}(${this.value})`;
};

// ----------------------------------------------------------------------

SymbolicNode.prototype.getImm = function(vars) {
  throw new Error(`Unknown expression type for getImm ${this.toString()}`);
};

SymbolicRef.prototype.getImm = function(vars) {
  let e = this;
  return vars[e.name];
};

SymbolicConst.prototype.getImm = function(vars) {
  let e = this;
  return e.value;
};

SymbolicExpr.prototype.getImm = function(vars) {
  let e = this;

  let argExprs = _.map(e.args, (arg) => {
    return arg.getImm(vars);
  });
  return e.opInfo.impl.imm.apply(e, argExprs);
};

/* ----------------------------------------------------------------------
  Taking derivatives
*/

SymbolicContext.prototype.D = function(wrt, e) {
  let c = this;
  assert.strictEqual(wrt.c, c);
  assert.strictEqual(e.c, c);
  return c.assertNode(e.getDeriv(wrt));
};

SymbolicNode.prototype.getDeriv = function(wrt) {
  let e = this;
  throw new Error(`Unknown expression type for getDeriv ${e.toString()}`);
};

SymbolicRead.prototype.getDeriv = function(wrt) {
  let e = this;
  let c = e.c;
  assert.strictEqual(wrt.c, c);
  if (e.ref === wrt) {
    return c.C(e.type, 1);
  } else {
    return c.C(e.type, 0);
  }
};

SymbolicRef.prototype.getDeriv = function(wrt) {
  let e = this;
  let c = e.c;
  assert.strictEqual(wrt.c, c);
  if (e === wrt) {
    return c.C(e.type, 1);
  } else {
    return c.C(e.type, 0);
  }
};

SymbolicConst.prototype.getDeriv = function(wrt) {
  let e = this;
  let c = e.c;

  return c.C(e.type, 0);
};

SymbolicExpr.prototype.getDeriv = function(wrt) {
  let e = this;
  let c = e.c;

  let derivFunc = e.opInfo.impl.deriv;
  if (!derivFunc) throw new Error(`No deriv impl for ${e.op}`);
  return derivFunc.apply(e, [c, wrt].concat(e.args));
};


/* ----------------------------------------------------------------------
  Gradients
*/

SymbolicContext.prototype.addGradients = function() {
  let c = this;
  let deps = c.getDeps();

  deps.letRdGrads = {};
  _.each(c.lets, function(ref) {
    if (!ref.opt.noGrad) {
      let gradName = `${ref.name}Grad`;
      if (c.lets[gradName]) {
        deps.letRdGrads[ref.cseKey] = c.lets[gradName];
      }
    }
  });

  let revOrder = _.clone(deps.inOrder).reverse();

  _.each(revOrder, (node, nodei) => {
    if (0) {
      console.log(`Step ${nodei}:`);
      _.each(deps.inOrder, (n1) => {
        console.log(`  ${
          n1 === node ? '=>' : '  '
        } ${
          util.inspect(n1)
        } gradients=${
          util.inspect(deps.gradients[n1.cseKey])
        } ${
          deps.totGradients[n1.cseKey] ? `tot=${util.inspect(deps.totGradients[n1.cseKey])}` : ``
        }`);
      });
    }
    node.backprop(deps);
  });

  _.each(deps.reads, function(rd) {
    assert.ok(rd.ref.isAddress);
    let gradRef = rd.ref.getGradient(deps);
    //debugger;
    if (!gradRef.isConst()) {
      c.W(gradRef, rd.getGradient(deps));
    }
    /*
    let gradName = rdMap(rd.name);
    if (gradName && gradName !== rd.name) {
      console.log(`${c.name}: Add rd gradient for ${rd.name} => ${gradName}`);
      let g1 = new SymbolicRef(c, rd.type, gradName, true);
      c.W(g1, rd.getGradient(deps));
    } else {
      console.log(`${c.name}: No rd gradient for ${rd.name}`);
    }
    */
  });
};

SymbolicNode.prototype.addGradient = function(deps, g) {
  let e = this;
  let c = e.c;
  assert.ok(deps.totGradients);
  c.assertNode(g);

  if (0) console.log(`addGradient ${util.inspect(g)} to ${util.inspect(e)}`);
  if (g.isZero()) {
    return;
  }
  if (deps.totGradients[e.cseKey]) {
    throw new Error(`addGradient ${util.inspect(g)} to ${util.inspect(e)}: gradient already consumed`);
  }
  if (!deps.gradients[e.cseKey]) {
    deps.gradients[e.cseKey] = [];
  }
  deps.gradients[e.cseKey].push(g);
};

SymbolicNode.prototype.getGradient = function(deps) {
  let e = this;
  let c = e.c;

  if (deps.letRdGrads[e.cseKey]) {
    return deps.letRdGrads[e.cseKey];
  }

  let totGradient = deps.totGradients[e.cseKey];
  if (totGradient) return totGradient;

  totGradient = null;
  _.each(deps.gradients[e.cseKey], function(g1) {
    if (totGradient === null) {
      totGradient = g1;
    } else {
      totGradient = c.E('+', totGradient, g1);
    }
  });
  if (totGradient === null) {
    totGradient = c.C(e.type, 0);
    assert.ok(totGradient.isZero());
  }
  if (0) console.log('getGradient', e, deps.gradients[e.cseKey], totGradient);
  deps.totGradients[e.cseKey] = totGradient;

  return totGradient;
};

SymbolicExpr.prototype.getGradient = function(deps) {
  let e = this;
  let c = e.c;
  if (!e.isAddress) {
    return SymbolicNode.prototype.getGradient.call(this, deps);
  }
  assert.equal(e.args.length, 1);
  return c.E(e.op, e.args[0].getGradient(deps));
};

SymbolicNode.prototype.backprop = function(deps) {
  let e = this;
  throw new Error(`Unknown backprop impl for ${util.inspect(e)}`);
};

// FIXME
SymbolicRef.prototype.backprop = function(deps) {
  let e = this;
  let c = e.c;
  let g = e.getGradient(deps);
};

SymbolicWrite.prototype.backprop = function(deps) {
  let e = this;
  let c = e.c;
  let g = e.ref.getGradient(deps);
  e.value.addGradient(deps, g);
};


SymbolicRead.prototype.backprop = function(deps) {
  let e = this;
  let c = e.c;
  let g = e.ref.getGradient(deps);
  // WRITEME?
};

SymbolicExpr.prototype.backprop = function(deps) {
  let e = this;
  let c = e.c;
  let g = e.getGradient(deps);

  let gradientFunc = e.opInfo.impl.gradient;
  if (!gradientFunc) {
    throw new Error(`No gradient impl for ${e.op}(${
      _.map(e.args, (a) => a.type.jsTypename).join(', ')
    })`);
  }
  return gradientFunc.apply(e, [c, deps, g].concat(e.args));
};

SymbolicConst.prototype.backprop = function(deps) {
  let e = this;
  let c = e.c;
  // nothing
};


/*
  Emitting code
*/

SymbolicNode.prototype.emitCses = function(lang, deps, f, availCses) {
  // nothing
};

SymbolicWrite.prototype.emitCses = function(lang, deps, f, availCses) {
  let e = this;

  e.value.emitCses(lang, deps, f, availCses);
};

SymbolicExpr.prototype.emitCses = function(lang, deps, f, availCses) {
  let e = this;
  let c = e.c;

  if (!availCses[e.cseKey]) {
    _.each(e.args, (arg) => {
      arg.emitCses(lang, deps, f, availCses);
    });
    if (deps.rev[e.cseKey].length > 1) {
      // Wrong for composite types, use TypeRegistry
      if (lang === 'c') {
        f(`${e.type.typename} ${e.cseKey} = ${e.getExpr(lang, availCses, 'rd')};`);
        if (e.printName) {
          f(`eprintf("${e.printName} ${e.cseKey} = %s\\n", asJson(${e.cseKey}).it.c_str());`);
        }
      }
      else if (lang === 'js') {
        f(`let ${e.cseKey} = ${e.getExpr(lang, availCses, 'rd')};`);
      }
      availCses[e.cseKey] = true;
    }
  }
};


SymbolicWrite.prototype.emitCode = function(lang, deps, f, availCses) {
  let e = this;

  e.emitCses(lang, deps, f, availCses);
  f(`${e.ref.getExpr(lang, availCses, 'wr')} = ${e.value.getExpr(lang, availCses, 'rd')};`);
};

SymbolicRead.prototype.getExpr = function(lang, availCses, rdwr) {
  return this.ref.getExpr(lang, availCses, 'rd');
};


SymbolicRef.prototype.getExpr = function(lang, availCses, rdwr) {
  if (this.dir === 'update' && rdwr === 'rd') {
    return `${this.name}Prev`;
  }
  else if (this.dir === 'update' && rdwr === 'wr') {
    return `${this.name}Next`;
  }
  else if (this.dir === 'in' && rdwr === 'rd') {
    return this.name;
  }
  else if (this.dir === 'out' && rdwr === 'wr') {
    return this.name;
  }
};

SymbolicConst.prototype.getExpr = function(lang, availCses, rdwr) {
  let e = this;
  let c = e.c;
  assert.ok(rdwr === 'rd');

  return e.type.getValueExpr(lang, e.value);
};

SymbolicExpr.prototype.getExpr = function(lang, availCses, rdwr) {
  let e = this;
  let c = e.c;

  if (availCses && availCses[e.cseKey]) {
    return e.cseKey;
  }
  let argExprs = _.map(e.args, (arg) => {
    return arg.getExpr(lang, availCses, rdwr);
  });
  let impl = e.opInfo.impl[lang];
  if (!impl) {
    throw new Error(`No ${lang} impl for ${e.op}(${_.map(e.args, (a) => a.type.jsTypename).join(', ')})`);
  }
  return impl.apply(e, argExprs);
};
