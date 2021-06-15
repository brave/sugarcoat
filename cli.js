// vim: set tw=99 ts=2 sw=2 et:

'use strict';

const crypto = require('crypto');
const path = require('path');

const am = require('am');
const { program } = require('commander');
const glob = require('fast-glob');
const fs = require('fs-extra');
const graphml = require('graphology-graphml');
const { iterate, zip } = require('iterare');
const { MultiDirectedGraph } = require('graphology');
const sanitizeFileName = require('sanitize-filename');
const { VError } = require('verror');

const { parseConfigFile } = require('./config');

program
  .version(require('./package.json').version)
  .requiredOption('-c, --config <path>', 'config JSON file path')
  .option('-i, --ingest', 'ingest Page Graph data and produce a trace of API accesses')
  .option('-R, --report', 'generated report of recorded API access sites')
  .option('-r, --rewrite', 'produce rewritten script files')
  .option('-b, --bundle', 'bundle rewrites into adblock data')
  .parse(require('process').argv);

const {
  config: configFilePath,
  ingest: shouldIngest,
  report: shouldReport,
  rewrite: shouldRewrite,
  bundle: shouldBundle,
} = program;

const requiredConfigKeys = new Set();
if (shouldIngest) {
  requiredConfigKeys.add('graphs');
  requiredConfigKeys.add('code');
  requiredConfigKeys.add('trace');
}
if (shouldReport) {
  requiredConfigKeys.add('trace');
  requiredConfigKeys.add('report');
}
if (shouldRewrite) {
  requiredConfigKeys.add('code');
  requiredConfigKeys.add('trace');
}
if (shouldBundle) {
  requiredConfigKeys.add('code');
  requiredConfigKeys.add('bundle');
}

const compilePolicy = policy => {
  if (policy) {
    if (policy.include) {
      const includeSet = new Set(policy.include);
      if (policy.exclude) {
        for (const binding of policy.exclude) {
          includeSet.delete(binding);
        }
      }
      return binding => includeSet.has(binding);
    }

    if (policy.exclude) {
      const excludeSet = new Set(policy.exclude);
      return binding => excludeSet.has(binding);
    }
  }

  return null;
};

am(async () => {
  let config;
  try {
    config = await parseConfigFile(configFilePath);
  } catch (err) {
    throw new VError(err, `Failed to load config JSON file ${JSON.stringify(configFilePath)}`);
  }

  const missingConfigKeys = iterate(requiredConfigKeys)
    .filter(key => !config[key])
    .toArray();
  if (missingConfigKeys.length > 0) {
    throw new Error(
      `Can't perform the requested operation(s) without the following config key(s): ${missingConfigKeys.join(
        ', '
      )}`
    );
  }

  const {
    graphs: graphFileGlobs,
    code: codeDirPath,
    trace: traceFilePath,
    report: reportFilePath,
    bundle: bundleConfig,
  } = config;

  const targets = config.targets
    ? Object.entries(config.targets).map(([name, data]) => ({ name, ...data }))
    : [];
  if (shouldIngest || shouldRewrite) {
    await Promise.all(
      targets.map(async target => {
        const origSrcFilePath = path.join(codeDirPath, `${target.name}.js`);

        let origSrc;
        try {
          origSrc = await fs.readFile(origSrcFilePath, { encoding: 'utf8' });
        } catch (err) {
          throw new VError(
            err,
            `Failed to read target source file ${JSON.stringify(origSrcFilePath)}`
          );
        }

        target.src = origSrc;
        target.srcHash = crypto.createHash('sha256').update(origSrc).digest('hex');
      })
    );
  }

  if (shouldIngest) {
    const graphFilePaths = await glob(graphFileGlobs);
    const graphs = await Promise.all(
      graphFilePaths.map(async graphFilePath => {
        try {
          const graphSrc = await fs.readFile(graphFilePath, { encoding: 'utf8' });
          return graphml.parse(MultiDirectedGraph, graphSrc);
        } catch (err) {
          throw new VError(err, `Failed to load Page Graph file ${JSON.stringify(graphFilePath)}`);
        }
      })
    );

    const tracesObj = Object.fromEntries(
      zip(targets, require('./ingest')(graphs, targets)).map(([target, trace]) => {
        target.trace = trace;
        return [target.name, { srcHash: target.srcHash, trace }];
      })
    );

    try {
      await fs.writeFile(traceFilePath, JSON.stringify(tracesObj, null, 2), { encoding: 'utf8' });
    } catch (err) {
      throw new VError(err, `Failed to write trace file ${JSON.stringify(traceFilePath)}`);
    }
  } else if (shouldReport || shouldRewrite) {
    let tracesObj;
    try {
      tracesObj = JSON.parse(await fs.readFile(traceFilePath, { encoding: 'utf8' }));
    } catch (err) {
      throw new VError(err, `Failed to load trace JSON file ${JSON.stringify(traceFilePath)}`);
    }

    for (const target of targets) {
      if (!Object.prototype.hasOwnProperty.call(tracesObj, target.name)) {
        throw new Error(
          `Trace file is missing an entry for target ${JSON.stringify(target.name)}`
        );
      }
      const { srcHash, trace } = tracesObj[target.name];
      if (target.srcHash !== srcHash) {
        throw new Error(
          `SHA-256 source hash for target ${JSON.stringify(target.name)} (${
            target.srcHash
          }) doesn't match hash recorded in trace file (${srcHash})`
        );
      }
      target.trace = trace;
    }
  }

  if (shouldReport) {
    const report = require('./report');
    const reportTemplate = await report.loadReportTemplate();
    const reportSrc = report(reportTemplate, targets);

    try {
      await fs.writeFile(reportFilePath, reportSrc, { encoding: 'utf8' });
    } catch (err) {
      throw new VError(err, `Failed to write report file ${JSON.stringify(reportFilePath)}`);
    }
  }

  let resources;
  if (shouldBundle) {
    if (shouldRewrite) {
      resources = [];
    } else {
    }
  }

  if (shouldRewrite) {
    const rewrite = require('./rewrite');

    let mocksMap;
    try {
      mocksMap = await rewrite.loadMocks();
    } catch (err) {
      throw new VError(err, 'Failed to load mocks library');
    }

    let recipesMap;
    try {
      recipesMap = await rewrite.loadRecipes(mocksMap);
    } catch (err) {
      throw new VError(err, 'Failed to load recipes library');
    }

    await Promise.all(
      targets.flatMap(target => {
        const rewriteData = rewrite(
          mocksMap,
          recipesMap,
          target.name,
          target.src,
          target.trace,
          compilePolicy(target.policy)
        );
        if (!rewriteData) {
          return [];
        }

        target.rewriteSrc = rewriteData.src;

        const rewriteSrcFilePath = path.join(codeDirPath, `sugarcoat-${target.name}.js`);
        const rewriteSrcMapFilePath = `${rewriteSrcFilePath}.map`;
        target.sugarcoated = true;

        return [
          (async () => {
            try {
              await fs.writeFile(rewriteSrcFilePath, rewriteData.src, { encoding: 'utf8' });
            } catch (err) {
              throw new VError(
                err,
                `Failed to write rewrite source file ${JSON.stringify(rewriteSrcFilePath)}`
              );
            }
          })(),
          (async () => {
            try {
              await fs.writeFile(rewriteSrcMapFilePath, rewriteData.srcMap, { encoding: 'utf8' });
            } catch (err) {
              throw new VError(
                err,
                `Failed to write rewrite source map file ${JSON.stringify(rewriteSrcMapFilePath)}`
              );
            }
          })(),
        ];
      })
    );
  } else if (shouldBundle) {
    await Promise.all(
      targets.map(async target => {
        const rewriteSrcFilePath = path.join(codeDirPath, `sugarcoat-${target.name}.js`);
        if (!(await fs.pathExists(rewriteSrcFilePath))) {
          return;
        }

        let rewriteSrc;
        try {
          rewriteSrc = await fs.readFile(rewritesSrcFilePath, { encoding: 'utf8' });
        } catch (err) {
          throw new VError(
            err,
            `Failed to read rewrite source file ${JSON.stringify(rewriteSrcFilePath)}`
          );
        }
        target.rewriteSrc = rewriteSrc;
        target.sugarcoated = true;
      })
    );
  }

  if (shouldBundle) {
    const { rules: rulesFilePath, resources: resourcesFilePath } = bundleConfig;

    const bundle = await require('./bundle')(
      targets
        .filter(target => target.sugarcoated) // only want to print rules for sugarcoated targets
        .map(target => ({
          name: `sugarcoat-${target.name}`,
          src: target.src,
          patterns: target.patterns,
        }))
    );

    await Promise.all([
      (async () => {
        try {
          await fs.writeFile(rulesFilePath, bundle.rules.join('\n'), { encoding: 'utf8' });
        } catch (err) {
          throw new VError(err, `Failed to write rules file ${JSON.stringify(rulesFilePath)}`);
        }
      })(),
      (async () => {
        try {
          await fs.writeFile(resourcesFilePath, JSON.stringify(bundle.resources, null, 2), {
            encoding: 'utf8',
          });
        } catch (err) {
          throw new VError(
            err,
            `Failed to write resources file ${JSON.stringify(resourcesFilePath)}`
          );
        }
      })(),
    ]);
  }
});
