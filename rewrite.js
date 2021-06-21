// vim: set tw=99 ts=2 sw=2 et:

'use strict';

const path = require('path');

const cryptoRandomString = require('crypto-random-string');
const escodegen = require('escodegen');
const esprima = require('esprima');
const fs = require('fs-extra');
const { iterate } = require('iterare');

const generateRandomVariableName = prefix =>
  `$___${prefix}_${cryptoRandomString({ length: 16, type: 'hex' })}`;

const isNodeLike = value => Object.prototype.hasOwnProperty.call(value, 'type');

const objectConstructorExpression = {
  type: 'MemberExpression',
  computed: false,
  object: {
    type: 'ObjectExpression',
    properties: [],
  },
  property: {
    type: 'Identifier',
    name: 'constructor',
  },
};

const rewriteNode = (accesses, node, preludeStatements = null) => {
  let bodyStatements = null;

  switch (node.type) {
    case 'Program': {
      bodyStatements = node.body;
      break;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
    case 'FunctionExpression': {
      if (node.type === 'ArrowFunctionExpression' && node.expression) {
        node.body = {
          type: 'BlockStatement',
          body: [
            {
              type: 'ReturnStatement',
              argument: node.body,
            },
          ],
        };
        node.expression = false;
      }

      bodyStatements = node.body.body;

      for (const param of node.params) {
        if (param.type === 'AssignmentPattern') {
          param.right = {
            type: 'CallExpression',
            callee: {
              type: 'ArrowFunctionExpression',
              params: [],
              body: param.right,
              expression: true,
              range: param.right.range,
            },
            arguments: [],
          };

          rewriteNode(accesses, param.right);
        }
      }

      break;
    }
  }

  if (bodyStatements) {
    const [start, end] = node.range;

    let indexOfFirstAccessInRange = null;
    let numAccessesInRange = 0;
    for (let accessIndex = 0; accessIndex < accesses.length; ++accessIndex) {
      const access = accesses[accessIndex];

      if (access.position >= end) {
        break;
      }

      if (indexOfFirstAccessInRange == null) {
        if (access.position < start) {
          continue;
        }
        indexOfFirstAccessInRange = accessIndex;
      }

      ++numAccessesInRange;
    }

    accesses =
      indexOfFirstAccessInRange == null
        ? []
        : accesses.splice(indexOfFirstAccessInRange, numAccessesInRange);
  }

  traverseObjectAndRewriteNodes(accesses, node);

  if (bodyStatements) {
    if (bodyStatements.length > 0 && accesses.length > 0) {
      const recipes = Array.from(new Set(accesses.map(access => access.recipe)));
      injectRewriteWrapper(recipes, bodyStatements, preludeStatements);
    } else if (preludeStatements) {
      const innerStatements = [...bodyStatements];
      const outerStatements = [
        {
          type: 'BlockStatement',
          body: [...preludeStatements, iifeDelegate(innerStatements, true)],
        },
      ];
      hoistVariables(outerStatements, innerStatements);
      bodyStatements.splice(0, bodyStatements.length, ...outerStatements);
    }
  }
};

const traverseObjectAndRewriteNodes = (accesses, thing) => {
  for (const value of Object.values(thing)) {
    traverseAndRewriteNodes(accesses, value);
  }
};

const traverseAndRewriteNodes = (accesses, thing) => {
  if (!thing || typeof thing !== 'object') {
    return;
  }

  if (Array.isArray(thing)) {
    for (const item of thing) {
      traverseAndRewriteNodes(accesses, item);
    }
  } else if (isNodeLike(thing)) {
    rewriteNode(accesses, thing);
  } else {
    traverseObjectAndRewriteNodes(accesses, thing);
  }
};

const injectRewriteWrapper = (recipes, bodyStatements, preludeStatements = null) => {
  const isTopLevel = !!preludeStatements;

  const oldDescriptorVariableNames = recipes.map(() => generateRandomVariableName('old'));

  const oldDescriptorVariableDeclarators = recipes.map((recipe, recipeIndex) => ({
    type: 'VariableDeclarator',
    id: {
      type: 'Identifier',
      name: oldDescriptorVariableNames[recipeIndex],
    },
    init: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        computed: false,
        object: objectConstructorExpression,
        property: {
          type: 'Identifier',
          name: 'getOwnPropertyDescriptor',
        },
      },
      arguments: [
        recipe.sourceObject,
        {
          type: 'Literal',
          value: recipe.sourceProperty,
        },
      ],
    },
  }));

  const applyRecipeStatements = recipes.map((recipe, recipeIndex) => ({
    type: 'IfStatement',
    test: {
      type: 'Identifier',
      name: oldDescriptorVariableNames[recipeIndex],
    },
    consequent: {
      type: 'ExpressionStatement',
      expression: recipe.destination
        ? {
            type: 'CallExpression',
            callee: {
              type: 'MemberExpression',
              computed: false,
              object: objectConstructorExpression,
              property: {
                type: 'Identifier',
                name: 'defineProperty',
              },
            },
            arguments: [
              recipe.sourceObject,
              {
                type: 'Literal',
                value: recipe.sourceProperty,
              },
              recipe.destination,
            ],
          }
        : {
            type: 'UnaryExpression',
            operator: 'delete',
            prefix: true,
            argument: {
              type: 'MemberExpression',
              computed: false,
              object: recipe.sourceObject,
              property: { type: 'Identifier', name: recipe.sourceProperty },
            },
          },
    },
  }));

  const undoRecipeStatements = recipes.map((recipe, recipeIndex) => {
    const oldDescriptorVariableName = oldDescriptorVariableNames[recipeIndex];
    return {
      type: 'IfStatement',
      test: {
        type: 'Identifier',
        name: oldDescriptorVariableName,
      },
      consequent: {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            computed: false,
            object: objectConstructorExpression,
            property: {
              type: 'Identifier',
              name: 'defineProperty',
            },
          },
          arguments: [
            recipe.sourceObject,
            {
              type: 'Literal',
              value: recipe.sourceProperty,
            },
            {
              type: 'Identifier',
              name: oldDescriptorVariableName,
            },
          ],
        },
      },
    };
  });

  const innerStatements = [...bodyStatements];

  let outerStatements = [
    ...(preludeStatements || []),
    {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: oldDescriptorVariableDeclarators,
    },
    {
      type: 'TryStatement',
      block: {
        type: 'BlockStatement',
        body: [...applyRecipeStatements, iifeDelegate(innerStatements, isTopLevel)],
      },
      handler: null,
      finalizer: {
        type: 'BlockStatement',
        body: undoRecipeStatements,
      },
    },
  ];

  if (isTopLevel) {
    outerStatements = [
      {
        type: 'BlockStatement',
        body: outerStatements,
      },
    ];

    hoistVariables(outerStatements, innerStatements);
  }

  bodyStatements.splice(0, bodyStatements.length, ...outerStatements);
};

const iifeDelegate = (bodyStatements, isTopLevel = false) => {
  const functionExpression = {
    type: 'FunctionExpression',
    params: [],
    body: {
      type: 'BlockStatement',
      body: bodyStatements,
    },
  };

  return isTopLevel
    ? {
        type: 'CallExpression',
        callee: functionExpression,
        arguments: [],
      }
    : {
        type: 'ReturnStatement',
        argument: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            computed: false,
            object: functionExpression,
            property: {
              type: 'Identifier',
              name: 'apply',
            },
          },
          arguments: [
            {
              type: 'ThisExpression',
            },
            {
              type: 'Identifier',
              name: 'arguments',
            },
          ],
        },
      };
};

const hoistVariables = (outerStatements, innerStatements) => {
  const hoistedOldStyleVariableDeclarators = [];
  const hoistedNewStyleVariableDeclarators = [];
  const hoistStatementsAndIndices = [];
  const functionDeclarationHoistStatements = [];

  for (let index = 0; index < innerStatements.length; ++index) {
    const statement = innerStatements[index];

    let declarations = null;
    let hoistedVariableDeclarators = null;
    let isFunctionDeclaration = false;
    switch (statement.type) {
      case 'VariableDeclaration': {
        declarations = statement.declarations;
        hoistedVariableDeclarators =
          statement.kind === 'var'
            ? hoistedOldStyleVariableDeclarators
            : hoistedNewStyleVariableDeclarators;
        break;
      }
      case 'FunctionDeclaration': {
        declarations = [statement];
        hoistedVariableDeclarators = hoistedOldStyleVariableDeclarators;
        isFunctionDeclaration = true;
        break;
      }
      default: {
        continue;
      }
    }

    for (const declarator of declarations) {
      const replacements = replaceDeclaredVariableNames(declarator.id);

      for (const replacement of replacements) {
        hoistedVariableDeclarators.push({
          type: 'VariableDeclarator',
          id: {
            type: 'Identifier',
            name: replacement.oldName,
          },
        });

        const hoistStatement = {
          type: 'ExpressionStatement',
          expression: {
            type: 'AssignmentExpression',
            operator: '=',
            left: {
              type: 'Identifier',
              name: replacement.oldName,
            },
            right: {
              type: 'Identifier',
              name: replacement.newName,
            },
          },
        };

        if (isFunctionDeclaration) {
          functionDeclarationHoistStatements.push(hoistStatement, {
            type: 'ExpressionStatement',
            expression: {
              type: 'CallExpression',
              callee: {
                type: 'MemberExpression',
                computed: false,
                object: objectConstructorExpression,
                property: {
                  type: 'Identifier',
                  name: 'defineProperty',
                },
              },
              arguments: [
                {
                  type: 'Identifier',
                  name: replacement.oldName,
                },
                {
                  type: 'Literal',
                  value: 'name',
                },
                {
                  type: 'ObjectExpression',
                  properties: [
                    {
                      type: 'Property',
                      key: {
                        type: 'Identifier',
                        name: 'configurable',
                      },
                      computed: false,
                      value: {
                        type: 'Literal',
                        value: true,
                      },
                      kind: 'init',
                    },
                    {
                      type: 'Property',
                      key: {
                        type: 'Identifier',
                        name: 'enumerable',
                      },
                      computed: false,
                      value: {
                        type: 'Literal',
                        value: false,
                      },
                      kind: 'init',
                    },
                    {
                      type: 'Property',
                      key: {
                        type: 'Identifier',
                        name: 'value',
                      },
                      computed: false,
                      value: {
                        type: 'Literal',
                        value: replacement.oldName,
                      },
                      kind: 'init',
                    },
                    {
                      type: 'Property',
                      key: {
                        type: 'Identifier',
                        name: 'writable',
                      },
                      computed: false,
                      value: {
                        type: 'Literal',
                        value: false,
                      },
                      kind: 'init',
                    },
                  ],
                },
              ],
            },
          });
        } else {
          hoistStatementsAndIndices.push({
            statement: hoistStatement,
            index,
          });
        }
      }
    }
  }

  if (hoistedNewStyleVariableDeclarators.length > 0) {
    outerStatements.unshift({
      type: 'VariableDeclaration',
      kind: 'let',
      declarations: hoistedNewStyleVariableDeclarators,
    });
  }

  if (hoistedOldStyleVariableDeclarators.length > 0) {
    outerStatements.unshift({
      type: 'VariableDeclaration',
      kind: 'var',
      declarations: hoistedOldStyleVariableDeclarators,
    });
  }

  for (let index = 0; index < hoistStatementsAndIndices.length; ++index) {
    const entry = hoistStatementsAndIndices[index];
    innerStatements.splice(index + entry.index + 1, 0, entry.statement);
  }

  innerStatements.unshift(...functionDeclarationHoistStatements);
};

const replaceDeclaredVariableNames = node => {
  if (node == null) {
    return [];
  }

  switch (node.type) {
    case 'ArrayPattern': {
      return node.elements.flatMap(item => replaceDeclaredVariableNames(item));
    }
    case 'AssignmentPattern': {
      return replaceDeclaredVariableNames(node.left);
    }
    case 'Identifier': {
      const oldName = node.name;
      const newName = (node.name = generateRandomVariableName('var'));
      return [{ oldName, newName }];
    }
    case 'ObjectPattern': {
      return node.properties.flatMap(property => {
        if (property.value == null) {
          const oldName = property.key;
          const newName = (property.key = generateRandomVariableName('var'));
          return [{ oldName, newName }];
        } else {
          return extractDeclaredVariableNames(property.value);
        }
      });
    }
    case 'RestElement': {
      return extractDeclaredVariableNames(node.argument);
    }
    default: {
      throw new RangeError(`Unexpected node type: ${node.type}`);
    }
  }
};

const readDirToMap = async (dirPath, ext, f) => {
  const fileNames = await fs.readdir(dirPath);
  return new Map(
    (
      await Promise.all(
        fileNames.map(fileName => {
          if (path.extname(fileName) !== ext) {
            return null;
          }
          const name = path.basename(fileName, ext);
          const filePath = path.join(dirPath, fileName);
          return (async () => [name, f(await fs.readFile(filePath, { encoding: 'utf8' }))])();
        })
      )
    ).filter(entry => entry)
  );
};

const rewrite = (mocksMap, recipesMap, scriptName, scriptSrc, trace, policy = null) => {
  let script;
  try {
    script = esprima.parseScript(scriptSrc, { loc: true, range: true, source: scriptName });
  } catch {
    return null;
  }

  const accesses = trace
    .map(entry => {
      if (policy && !policy(entry.binding)) {
        return null;
      }
      const recipe = recipesMap.get(entry.binding);
      if (recipe) {
        return {
          position: entry.position,
          recipe: recipesMap.get(entry.binding),
        };
      } else {
        return null;
      }
    })
    .filter(access => access);

  if (accesses.length < 1) {
    return null;
  }

  const usedRecipes = new Set(accesses.map(access => access.recipe));
  const usedMocks = new Set(
    iterate(usedRecipes)
      .map(recipe => recipe.destinationMock)
      .filter(mock => mock)
  );
  const mockInitializationStatements = iterate(usedMocks)
    .map(mock => mock.initializationStatements)
    .flatten()
    .toArray();

  rewriteNode(accesses, script, mockInitializationStatements);

  const { code: rewriteSrc, map: rewriteSrcMap } = escodegen.generate(script, {
    /*
    format: {
      compact: true,
    },
    */
    sourceMap: true,
    sourceMapWithCode: true,
  });
  return { src: rewriteSrc, srcMap: rewriteSrcMap.toString() };
};
module.exports = rewrite;

const mocksDirPath = path.join(__dirname, 'mocks');
const loadMocks = async () => {
  const mocksMap = await readDirToMap(mocksDirPath, '.js', src => ({ src }));
  for (const mock of mocksMap.values()) {
    const mockBody = esprima.parseScript(mock.src).body;
    delete mock.src;

    mock.variableName = generateRandomVariableName('mock');
    mock.initializationStatements = [
      {
        type: 'VariableDeclaration',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: {
              type: 'Identifier',
              name: mock.variableName,
            },
            init: {
              type: 'ObjectExpression',
              properties: [],
            },
          },
        ],
        kind: 'const',
      },
      {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: {
            type: 'ArrowFunctionExpression',
            params: [
              {
                type: 'Identifier',
                name: 'exports',
              },
            ],
            body: {
              type: 'BlockStatement',
              body: mockBody,
            },
          },
          arguments: [
            {
              type: 'Identifier',
              name: mock.variableName,
            },
          ],
        },
      },
    ];
  }
  return mocksMap;
};
rewrite.loadMocks = loadMocks;

const recipesDirPath = path.join(__dirname, 'recipes');
const loadRecipes = async mocksMap => {
  const recipesMap = await readDirToMap(recipesDirPath, '.json', src => JSON.parse(src));
  for (const recipe of recipesMap.values()) {
    recipe.sourceObject = recipe.sourceObject.reduce(
      (accumulator, currentValue) =>
        accumulator
          ? {
              type: 'MemberExpression',
              computed: false,
              object: accumulator,
              property: { type: 'Identifier', name: currentValue },
            }
          : { type: 'Identifier', name: currentValue },
      null
    );

    if (recipe.destinationMock) {
      recipe.destinationMock = mocksMap.get(recipe.destinationMock);

      recipe.destination = {
        type: 'MemberExpression',
        object: {
          type: 'Identifier',
          name: recipe.destinationMock.variableName,
        },
        property: {
          type: 'Identifier',
          name: recipe.destinationProperty || recipe.sourceProperty,
        },
      };
    } else {
      recipe.destination = null;
    }
  }
  return recipesMap;
};
rewrite.loadRecipes = loadRecipes;
