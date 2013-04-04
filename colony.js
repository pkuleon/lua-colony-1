var fs = require('fs')
  , falafel = require('falafel')
  , colors = require('colors');


/** 
 * Colonize
 */

var keywords = ["end"];
var mask = ['string', 'math'];
var locals = ['this', 'Object', 'Array', 'String', 'Math', 'require', 'console']

function fixIdentifiers (str) {
  if (keywords.indexOf(str) > -1) {
    return '_K_' + str;
  }
  return str.replace(/_/g, '__').replace(/\$/g, '_S');
}

function uniqueStrings (arr) {
  var o = {};
  arr.forEach(function (k) {
    o[k] = true;
  });
  return Object.keys(o);
}

function attachIdentifierToContext (id, node) {
  var name = fixIdentifiers(id.source());
  while (node = node.parent) {
    if (node.type == 'FunctionDeclaration' || node.type == 'Program') {
      (node.identifiers || (node.identifiers = [])).push(name);
      node.identifiers = uniqueStrings(node.identifiers);
      return;
    }
  }
}

function colonizeContext (ids, node) {
  node.update([
    // Variables
    ids && ids.length ? 'local ' + ids.join(', ') + ';' : '',
    // Hoist Functions
    node.body.filter(function (stat) {
      return stat.type == 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n'),
    // Statements
    node.body.filter(function (stat) {
      return stat.type != 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n')
  ].filter(function (n) {
    return n;
  }).join('\n'));
}

var labels = [];
var loops = [];

function colonize (node) {
  
  switch (node.type) {
    case 'Identifier':
      node.update(fixIdentifiers(node.source()));
      break;

    case 'AssignmentExpression':
      // +=, -=, etc.
      if (node.operator != '=') {
        node.right.update(node.left.source() + ' ' + node.operator.substr(0, 1) + ' ' + node.right.source());
        node.operator = '=';
      }
      // Used in another expression, assignments must be wrapped by a closure.
      if (node.parent.type != 'ExpressionStatement') {
        node.update('(function () local _r = ' + node.right.source() + '; ' + node.left.source() + ' = _r; return _r; end)()');
      } else {
        // Need to refresh thanks to += updating.
        node.update(node.left.source() + ' = ' + node.right.source());
      }
      break;

    case 'ThisExpression':
      break;  

    case 'UnaryExpression':
    case 'BinaryExpression':
      if (node.operator == '<<') {
        node.update('_JS._bit.lshift(' + node.left.source() + ', ' + node.right.source() + ')');
      } else {
        node.update('(' + node.source() + ')');
      }
      break;

    case 'UpdateExpression':
      // ++ or --
      if (node.prefix) {
        node.update('(function () ' + node.argument.source() + ' = ' + node.argument.source() + ' ' + node.operator.substr(0, 1) + ' 1; return ' + node.argument.source() + '; end)()');
      } else {
        node.update('(function () local _r = ' + node.argument.source() + '; ' + node.argument.source() + ' = _r ' + node.operator.substr(0, 1) + ' 1; return _r end)()');
      }
      break;

    case 'NewExpression':
      node.update("_JS._new(" +
        [node.callee.source()].concat(node.arguments.map(function (arg) {
          return arg.source();
        })).join(', ') + ")");
      break;

    case 'VariableDeclarator':
      attachIdentifierToContext(node.id, node);
      break;

    case 'VariableDeclaration':
      node.update(node.declarations.map(function (d) {
        return d.id.source();
      }).join(', ') + ' = ' + node.declarations.map(function (d) {
        return d.init ? d.init.source() : 'nil'
      }).join(', ') + ';');
      break;

    case 'ForStatement':
      // {ln, init, expr, step, stat} = n
      // expr = {type: "boolean-literal", ln: ln, value: true} unless expr
      // ascend = [""].concat(x[1] for x in loops when x[0] != 'try' and x[1]).join(' or ')
      // name = labels.pop() or ""
      // cont = stat and usesContinue(stat, name)
      // loops.push(["for", name, cont])
      // ret = (if init then (if init.type == "var-stat" then colonize(init) else colonize({type: "expr-stat", ln: ln, expr: init}) + "\n") else "") +
      //   "while #{truthy(expr)} do\n" +
      //   (if cont then "local _c#{name} = nil; repeat\n" else "") +
      //   colonize(stat) + "\n" +
      //   (if cont then "until true;\n" else "") +
      //   (if step then colonize({type: "expr-stat", ln: step.ln, expr: step}) + "\n" else "") +
      //   # _cname = _JS._break OR ANYTHING ABOVE IT ~= nil then...
      //   (if cont then "if _c#{name} == _JS._break #{ascend} then break end\n" else "") + 
      //   "end"
      // loops.pop()
      // return ret
      node.update([
        node.init ? node.init.source() : '',
        'while ' + (node.test ? node.test.source() : 'true') + ' do',
        node.body.source(),
        node.update ? node.update.source() : '',
        'end'
      ].join('\n'))
      break;

    case 'Literal':
      node.update('(' + JSON.stringify(node.value) + ')');
      break;

    case 'CallExpression':
      if (node.callee.type == 'MemberExpression') {
        // Method call
        node.update(node.callee.object.source() + ':'
          + node.callee.property.source()
          // + '[' + (node.callee.property.type == 'Identifier' ? JSON.stringify(node.callee.property.source()) : node.callee.property.source()) + ']'
          + '(' + node.arguments.map(function (arg) {
          return arg.source()
        }).join(', ') + ')')
      } else {
        node.update(node.callee.source() + '(' + ['this'].concat(node.arguments.map(function (arg) {
          return arg.source()
        })).join(', ') + ')')
      }
      break;

    case 'ArrayExpression':
      if (!node.elements.length) {
        node.update("_JS._arr({})");
      } else {
        node.update("_JS._arr({[0]=" + [].concat(node.elements.map(function (el) {
          return el.source();
        })).join(', ') + "})");
      }
      break;

    case 'IfStatement':
      node.update([
        "if _JS._truthy(" + node.test.source() + ") then\n",
        node.consequent.source() + '\n',
        (node.alternate ? 'else\n' + node.alternate.source() + '\n' : ""),
        "end"
      ].join(''));
      break;

    case 'ReturnStatement':
      // Wrap in conditional to allow returns to precede statements
      node.update("if true then return" + (node.argument ? ' ' + node.argument.source() : '') + "; end;");
      break;

    case 'BlockStatement':
      colonizeContext(node.parent.type == 'FunctionDeclaration' ? node.parent.identifiers : [], node);
      break;

    case 'FunctionExpression':
    case 'FunctionDeclaration':
      if (node.id && !node.expression) {
        attachIdentifierToContext(node.id, node);
      }

      node.identifiers || (node.identifiers = []);

      // fix references
      var name = node.id && node.id.source();
      var args = node.params.map(function (arg) {
        return arg.source();
      });

      // expression prefix/suffix
      if (!node.expression && name) {
        var prefix = name + ' = ', suffix = ';';
      } else {
        var prefix = '', suffix = '';
      }

      // assign self-named function reference only when necessary
      var namestr = "";
      if (node.identifiers.indexOf(name) > -1) {
        namestr = "local " + name + " = debug.getinfo(1, 'f').func;\n";
      }

      var loopsbkp = loops;
      var loops = [];
      if (node.identifiers.indexOf('arguments') > -1) {
        node.update(prefix + "_JS._func(function (this, ...)\n" + namestr +
          "local arguments = _JS._arr((function (...) return arg; end)(...));\n" +
          (args.length ? "local " + args.join(', ') + " = ...;\n" : "") +
          node.body.source() + "\n" +
          "end)" + suffix);
      } else {
        node.update(prefix + "_JS._func(function (" + ['this'].concat(args).join(', ') + ")\n" + namestr +
          node.body.source() + "\n" +
          "end)" + suffix);
      }

      loops = loopsbkp;
      break;

    case 'MemberExpression':
      if (!node.parent.type == 'CallExpression') {
        node.update("(" + node.object.source() + ")"
          + '[' + (node.property.type == 'Identifier' ? JSON.stringify(node.property.source()) : node.property.source()) + ']');
      }
      break;

    case 'ExpressionStatement':
      node.update(node.source().replace(/;?$/, ';'));
      break;

    case 'Program':
      colonizeContext(node.identifiers, node);
      node.update([
        "local _JS = require('colony-js');",
        "local " + mask.join(', ') + ' = ' + mask.map(function () { return 'nil'; }).join(', ') + ';',
        "local " + locals.join(', ') + ' = ' + locals.map(function (k) { return '_JS.' + k; }).join(', ') + ';',
        "local _exports = {}; local exports = _exports;",
        "",
        node.source(),
        "",
        "return _exports;"
      ].join('\n'));
      break;

    default:
      console.log(node.type.red, node);
  }
}


/**
 * Output
 */

var src = fs.readFileSync('examples/binarytrees.js', 'utf-8');
var out = falafel(src, colonize);
console.log(String(out).replace(/\/\//g, '--'));