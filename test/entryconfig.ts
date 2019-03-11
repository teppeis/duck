import assert = require('assert');
import path from 'path';
import {loadEntryConfig, PlovrMode} from '../src/entryconfig';

const fixturesBaseDir = path.join(__dirname, 'fixtures');
const fixturesDir = path.join(fixturesBaseDir, 'entryconfig');

describe('entryconfig', () => {
  describe('loadEntryConfig', () => {
    it('loads simple config', async () => {
      const config = await loadEntryConfig('simple', fixturesDir);
      assert.deepEqual(config, {
        id: 'simple',
        mode: 'RAW',
        inputs: [path.join(fixturesBaseDir, 'js', 'foo.js')],
        externs: [
          path.join(fixturesBaseDir, 'ext', 'foo.js'),
          path.join(fixturesDir, 'ext', 'bar.js'),
        ],
        paths: [path.join(fixturesBaseDir, 'path1')],
      });
    });
    it('overrides `mode`', async () => {
      const config = await loadEntryConfig('simple', fixturesDir, {mode: PlovrMode.ADVANCED});
      assert(config.mode === PlovrMode.ADVANCED);
    });
    it('load chunks config', async () => {
      const config = await loadEntryConfig('chunks', fixturesDir);
      assert.deepEqual(config, {
        id: 'chunks',
        mode: 'RAW',
        modules: {
          base: {
            inputs: [path.join(fixturesBaseDir, 'js', 'base.js')],
            deps: [],
          },
          chunk1: {
            inputs: [path.join(fixturesDir, 'js', 'chunk1.js')],
            deps: ['base'],
          },
        },
        paths: [path.join(fixturesBaseDir, 'path1')],
      });
    });
    it('normalizes chunks config', async () => {
      const config = await loadEntryConfig('chunks-normalize', fixturesDir);
      assert.deepEqual(config, {
        id: 'chunks-normalize',
        mode: 'RAW',
        modules: {
          base: {
            inputs: [path.join(fixturesBaseDir, 'js', 'base.js')],
            deps: [],
          },
          chunk1: {
            inputs: [path.join(fixturesDir, 'js', 'chunk1.js')],
            deps: ['base'],
          },
        },
        paths: [path.join(fixturesBaseDir, 'path1')],
      });
    });
    it('inherits parent configs', async () => {
      const config = await loadEntryConfig(
        'grandchild',
        path.join(fixturesDir, 'child', 'grandchild')
      );
      assert.deepEqual(config, {
        id: 'grandchild',
        mode: 'RAW',
        // resolve relative paths based on root json
        inputs: [path.join(fixturesBaseDir, 'js', 'foo.js')],
        externs: [path.join(fixturesBaseDir, 'ext', 'foo.js')],
        paths: [path.join(fixturesBaseDir, 'path1')],
        debug: true,
      });
    });
  });
});