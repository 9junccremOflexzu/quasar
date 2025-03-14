const path = require('node:path')
const { existsSync } = require('node:fs')
const { removeSync } = require('fs-extra')
const { merge } = require('webpack-merge')
const { green } = require('kolorist')
const { build: esBuild, context: esContextBuild } = require('esbuild')
const debounce = require('lodash/debounce.js')

const appPaths = require('./app-paths.js')
const { appPkg, quasarPkg } = require('./app-pkg.js')
const { log, warn, fatal } = require('./utils/logger.js')
const { extensionsRunner } = require('./app-extension/extensions-runner.js')
const { appFilesValidations } = require('./utils/app-files-validations.js')
const { cssVariables } = require('./utils/css-variables.js')
const { getPackage } = require('./utils/get-package.js')
const getPackageMajorVersion = require('./utils/get-package-major-version.js')
const storeProvider = require('./utils/store-provider.js')
const { createWebpackConfig } = require('./webpack/index.js')
const { readFileEnv } = require('./utils/env.js')

const transformAssetUrls = getPackage('quasar/dist/transforms/loader-asset-urls.json')
const urlRegex = /^http(s)?:\/\//

const tempFile = `${ appPaths.quasarConfigFilename }.temporary.compiled.cjs`

function getEsbuildConfig () {
  return {
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    entryPoints: [ appPaths.quasarConfigFilename ],
    outfile: tempFile,
    plugins: []
  }
}

function encode (obj) {
  return JSON.stringify(obj, (_, value) => {
    return typeof value === 'function'
      ? `/fn(${ value.toString() })`
      : value
  })
}

function clone (obj) {
  return JSON.parse(JSON.stringify(obj))
}

function escapeHTMLTagContent (str) {
  return str ? str.replace(/[<>]/g, '') : ''
}
function escapeHTMLAttribute (str) {
  return str ? str.replace(/\"/g, '') : ''
}

function formatPublicPath (path) {
  if (!path) {
    return ''
  }

  if (!path.endsWith('/')) {
    path = `${ path }/`
  }

  if (urlRegex.test(path) === true) {
    return path
  }

  if (!path.startsWith('/')) {
    path = `/${ path }`
  }

  return path
}

function formatRouterBase (publicPath) {
  if (!publicPath || !publicPath.startsWith('http')) {
    return publicPath
  }

  const match = publicPath.match(/^(https?\:)\/\/(([^:\/?#]*)(?:\:([0-9]+))?)([\/]{0,1}[^?#]*)(\?[^#]*|)(#.*|)$/)
  return formatPublicPath(match[ 5 ] || '')
}

function parseAssetProperty (prefix) {
  return asset => {
    if (typeof asset === 'string') {
      return {
        path: asset[ 0 ] === '~' ? asset.substring(1) : prefix + `/${ asset }`
      }
    }

    return {
      ...asset,
      path: typeof asset.path === 'string'
        ? (asset.path[ 0 ] === '~' ? asset.path.substring(1) : prefix + `/${ asset.path }`)
        : asset.path
    }
  }
}

function getUniqueArray (original) {
  return Array.from(new Set(original))
}

function uniquePathFilter (value, index, self) {
  return self.map(obj => obj.path).indexOf(value.path) === index
}

function uniqueRegexFilter (value, index, self) {
  return self.map(regex => regex.toString()).indexOf(value.toString()) === index
}

module.exports.QuasarConfigFile = class QuasarConfigFile {
  ctx
  opts
  quasarConf
  webpackConf

  #isWatching = false
  #configSnapshot
  #webpackConfChanged

  constructor (ctx, opts = {}) {
    this.ctx = ctx
    this.opts = opts
  }

  read () {
    const esbuildConfig = getEsbuildConfig()
    return this.opts.watch !== void 0
      ? this.#buildAndWatch(esbuildConfig)
      : this.#build(esbuildConfig)
  }

  // start watching for changes
  watch () {
    this.#isWatching = true
  }

  async #build (esbuildConfig) {
    try {
      await esBuild(esbuildConfig)
    }
    catch (e) {
      removeSync(tempFile)
      console.log()
      console.error(e)
      fatal('Could not compile quasar.config file because it has errors', 'FAIL')
    }

    let fnResult
    try {
      fnResult = require(tempFile)
    }
    catch (e) {
      removeSync(tempFile)
      console.log()
      console.error(e)
      fatal('The quasar.config file has runtime errors', 'FAIL')
    }

    removeSync(tempFile)

    const quasarConfigFn = fnResult.default || fnResult
    return this.#computeConfig(quasarConfigFn, true)
  }

  async #buildAndWatch (esbuildConfig) {
    let firstBuildIsDone

    esbuildConfig.plugins.push({
      name: 'quasar:watcher',
      setup: build => {
        let isFirst = true
        let updateFn

        const scheduleUpdate = debounce(() => {
          this.opts.watch[ updateFn ]()
          updateFn = null
        }, 1000)

        build.onStart(() => {
          if (isFirst === false) {
            log('The quasar.config file changed. Reading it...')
          }
        })

        build.onEnd(async result => {
          if (isFirst === false && this.#isWatching === false) {
            // not ready yet; watch() has not been issued yet
            return
          }

          delete require.cache[ tempFile ]

          if (result.errors.length !== 0) {
            removeSync(tempFile)

            if (isFirst === true) {
              fatal('Could not compile quasar.config file because it has errors', 'FAIL')
            }

            warn('Could not compile quasar.config file because it has errors. Please fix them then save the file again.\n')
            return
          }

          let quasarConfigFn

          try {
            const result = require(tempFile)
            quasarConfigFn = result.default || result
          }
          catch (e) {
            removeSync(tempFile)
            console.log()
            console.error(e)

            if (isFirst === true) {
              fatal('Importing quasar.config file results in error', 'FAIL')
            }

            warn('Importing quasar.config file results in error. Please review the file then save it again.\n')
            return
          }

          removeSync(tempFile)
          delete require.cache[ tempFile ]

          const { quasarConf, webpackConf } = await this.#computeConfig(quasarConfigFn, isFirst)

          if (isFirst === true) {
            isFirst = false
            firstBuildIsDone({ quasarConf, webpackConf })
            return
          }

          if (quasarConf !== void 0) {
            // if triggering updates too fast, then remember
            // if any of them required the rebuild
            updateFn = updateFn === 'onBuildChange' || this.#webpackConfChanged === true
              ? 'onBuildChange'
              : 'onAppChange'

            log('Scheduled to apply quasar.config changes in 1s')
            scheduleUpdate()
          }
        })
      }
    })

    const esbuildCtx = await esContextBuild(esbuildConfig)
    await esbuildCtx.watch()

    return new Promise(res => { // eslint-disable-line promise/param-names
      firstBuildIsDone = res
    })
  }

  // return void 0 if it encounters errors
  // and { quasarConf, webpackConf } otherwise
  async #computeConfig (quasarConfigFn, failOnError) {
    if (typeof quasarConfigFn !== 'function') {
      if (failOnError === true) {
        fatal('The default export value of the quasar.config file is not a function', 'FAIL')
      }

      warn('The default export value of the quasar.config file is not a function. Please fix it then save the file again.\n')
      return
    }

    let userCfg

    try {
      userCfg = await quasarConfigFn(this.ctx)
    }
    catch (e) {
      console.log()
      console.error(e)

      if (failOnError === true) {
        fatal('The quasar.config file has runtime errors', 'FAIL')
      }

      warn('The quasar.config file has runtime errors. Please fix them then save the file again.\n')
      return
    }

    if (Object(userCfg) !== userCfg) {
      if (failOnError === true) {
        fatal('The quasar.config file does not default exports an Object', 'FAIL')
      }

      warn('The quasar.config file does not default exports an Object. Please fix it then save the file again.\n')
      return
    }

    const cfg = merge({
      ctx: this.ctx,

      css: [],
      boot: [],

      vendor: {
        add: [],
        remove: []
      },

      build: {
        transpileDependencies: [],
        vueLoaderOptions: {
          transformAssetUrls: {}
        },
        sassLoaderOptions: {},
        scssLoaderOptions: {},
        stylusLoaderOptions: {},
        lessLoaderOptions: {},
        tsLoaderOptions: {},
        tsCheckerOptions: {},
        env: {},
        rawDefine: {},
        envFiles: [],
        uglifyOptions: {
          compress: {},
          mangle: {}
        }
      },

      devServer: {
        server: {}
      },

      framework: {
        components: [],
        directives: [],
        plugins: []
      },

      animations: [],
      extras: [],
      sourceFiles: {},

      ssr: {
        middlewares: []
      },
      pwa: {
        workboxOptions: {},
        manifest: {
          icons: []
        },
        metaVariables: {}
      },
      electron: {
        inspectPort: 5858,
        unPackagedInstallParams: [],
        packager: {},
        builder: {}
      },
      cordova: {},
      capacitor: {
        capacitorCliPreparationParams: []
      },
      bex: {
        builder: {
          directories: {}
        }
      },

      bin: {},
      htmlVariables: {}
    }, userCfg)

    if (cfg.animations === 'all') {
      const { animations } = require('./utils/animations.js')
      cfg.animations = animations
    }

    if (!cfg.framework.plugins) {
      cfg.framework.plugins = []
    }
    if (!cfg.framework.config) {
      cfg.framework.config = {}
    }

    if (this.ctx.dev) {
      if (this.opts.host) {
        cfg.devServer.host = this.opts.host
      }
      else if (!cfg.devServer.host) {
        cfg.devServer.host = '0.0.0.0'
      }

      if (this.opts.port) {
        cfg.devServer.port = this.opts.port
      }
      else if (!cfg.devServer.port) {
        cfg.devServer.port = 8080
      }

      if (
        this.address
        && this.address.from.host === cfg.devServer.host
        && this.address.from.port === cfg.devServer.port
      ) {
        cfg.devServer.host = this.address.to.host
        cfg.devServer.port = this.address.to.port
      }
      else {
        const addr = {
          host: cfg.devServer.host,
          port: cfg.devServer.port
        }
        const to = this.opts.onAddress !== void 0
          ? await this.opts.onAddress(addr)
          : addr

        // if network error while running
        if (to === null) {
          throw new Error('NETWORK_ERROR')
        }

        cfg.devServer = merge({}, cfg.devServer, to)
        this.address = {
          from: addr,
          to: {
            host: cfg.devServer.host,
            port: cfg.devServer.port
          }
        }
      }
    }

    await extensionsRunner.runHook('extendQuasarConf', async hook => {
      log(`Extension(${ hook.api.extId }): Extending quasar.config file...`)
      await hook.fn(cfg, hook.api)
    })

    // If watching for changes then determine the type of them (webpack or not).
    // The snapshot below should only contain webpack config:
    if (this.opts.watch !== void 0) {
      const newConfigSnapshot = [
        cfg.build ? encode(cfg.build) : '',
        cfg.ssr && cfg.ssr.pwa ? encode(cfg.ssr.pwa) : '',
        cfg.framework ? cfg.framework.autoImportComponentCase : '',
        cfg.devServer ? encode(cfg.devServer) : '',
        cfg.pwa ? encode(cfg.pwa) : '',
        cfg.electron ? encode(cfg.electron) : '',
        cfg.bex ? encode(cfg.bex) : '',
        cfg.htmlVariables ? encode(cfg.htmlVariables) : ''
      ].join('')

      if (this.#configSnapshot) {
        this.#webpackConfChanged = newConfigSnapshot !== this.#configSnapshot
      }

      this.#configSnapshot = newConfigSnapshot
    }

    const rawDefine = {
      // vue
      __VUE_OPTIONS_API__: cfg.build.vueOptionsApi !== false,
      __VUE_PROD_DEVTOOLS__: this.ctx.dev === true || this.ctx.debug === true,

      // quasar
      __QUASAR_VERSION__: JSON.stringify(quasarPkg.version),
      __QUASAR_SSR__: this.ctx.mode.ssr === true,
      __QUASAR_SSR_SERVER__: false,
      __QUASAR_SSR_CLIENT__: false,
      __QUASAR_SSR_PWA__: false,

      // vue-i18n
      __VUE_I18N_FULL_INSTALL__: true,
      __VUE_I18N_LEGACY_API__: true,
      __VUE_I18N_PROD_DEVTOOLS__: this.ctx.dev === true || this.ctx.debug === true,
      __INTLIFY_PROD_DEVTOOLS__: this.ctx.dev === true || this.ctx.debug === true
    }

    cfg.__needsAppMountHook = false
    cfg.__vueDevtools = false

    if (cfg.vendor.disable !== true) {
      cfg.vendor.add = cfg.vendor.add.length > 0
        ? new RegExp(cfg.vendor.add.filter(v => v).join('|'))
        : void 0

      cfg.vendor.remove = cfg.vendor.remove.length > 0
        ? new RegExp(cfg.vendor.remove.filter(v => v).join('|'))
        : void 0
    }

    if (cfg.css.length > 0) {
      cfg.css = cfg.css.filter(_ => _)
        .map(parseAssetProperty('src/css'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.boot.length > 0) {
      cfg.boot = cfg.boot.filter(_ => _)
        .map(parseAssetProperty('boot'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.extras.length > 0) {
      cfg.extras = getUniqueArray(cfg.extras)
    }

    if (cfg.animations.length > 0) {
      cfg.animations = getUniqueArray(cfg.animations)
    }

    if (![ 'kebab', 'pascal', 'combined' ].includes(cfg.framework.autoImportComponentCase)) {
      cfg.framework.autoImportComponentCase = 'kebab'
    }

    // special case where a component can be designated for a framework > config prop
    if (cfg.framework.config && cfg.framework.config.loading) {
      const component = cfg.framework.config.loading.spinner
      // Is a component and is a QComponent
      if (component !== void 0 && /^(Q[A-Z]|q-)/.test(component) === true) {
        cfg.framework.components.push(component)
      }
    }

    cfg.framework.components = getUniqueArray(cfg.framework.components)
    cfg.framework.directives = getUniqueArray(cfg.framework.directives)
    cfg.framework.plugins = getUniqueArray(cfg.framework.plugins)

    cfg.build = merge({
      vueLoaderOptions: {
        transformAssetUrls: clone(transformAssetUrls)
      },

      showProgress: true,
      productName: appPkg.productName,
      productDescription: appPkg.description,
      // need to force extraction for SSR due to
      // missing functionality in vue-loader
      extractCSS: this.ctx.prod || this.ctx.mode.ssr,
      sourceMap: this.ctx.dev,
      minify: this.ctx.prod && this.ctx.mode.bex !== true,
      distDir: path.join('dist', this.ctx.modeName),
      htmlFilename: 'index.html',
      ssrPwaHtmlFilename: 'offline.html', // do NOT use index.html as name!
      // will mess up SSR
      vueRouterMode: 'hash',
      transpile: true,
      // transpileDependencies: [], // leaving here for completeness
      devtool: this.ctx.dev
        ? 'eval-cheap-module-source-map'
        : 'source-map',
      // env: {}, // leaving here for completeness
      uglifyOptions: {
        compress: {
          // turn off flags with small gains to speed up minification
          arrows: false,
          collapse_vars: false, // 0.3kb
          comparisons: false,
          computed_props: false,
          hoist_funs: false,
          hoist_props: false,
          hoist_vars: false,
          inline: false,
          loops: false,
          negate_iife: false,
          properties: false,
          reduce_funcs: false,
          reduce_vars: false,
          switches: false,
          toplevel: false,
          typeofs: false,

          // a few flags with noticeable gains/speed ratio
          // numbers based on out of the box vendor bundle
          booleans: true, // 0.7kb
          if_return: true, // 0.4kb
          sequences: true, // 0.7kb
          unused: true, // 2.3kb

          // required features to drop conditional branches
          conditionals: true,
          dead_code: true,
          evaluate: true
        },
        mangle: {
          safari10: true
        }
      }
    }, cfg.build)

    if (cfg.build.transpile === true) {
      cfg.build.transpileDependencies = cfg.build.transpileDependencies.filter(uniqueRegexFilter)
      cfg.__transpileBanner = green('yes (Babel)')
    }
    else {
      cfg.__transpileBanner = 'no'
    }

    cfg.__loadingBar = cfg.framework.plugins.includes('LoadingBar')
    cfg.__meta = cfg.framework.plugins.includes('Meta')

    if (this.ctx.dev || this.ctx.debug) {
      Object.assign(cfg.build, {
        minify: false,
        gzip: false
      })
    }
    // need to force extraction for SSR due to
    // missing functionality in vue-loader
    if (this.ctx.dev && !this.ctx.mode.ssr) {
      cfg.build.extractCSS = false
    }
    if (this.ctx.debug) {
      cfg.build.sourceMap = true
    }

    if (this.ctx.mode.ssr) {
      Object.assign(cfg.build, {
        vueRouterMode: 'history',
        gzip: false
      })
    }
    else if (this.ctx.mode.cordova || this.ctx.mode.capacitor || this.ctx.mode.electron || this.ctx.mode.bex) {
      Object.assign(cfg.build, {
        htmlFilename: 'index.html',
        vueRouterMode: 'hash',
        gzip: false
      })
    }

    if (!path.isAbsolute(cfg.build.distDir)) {
      cfg.build.distDir = appPaths.resolve.app(cfg.build.distDir)
    }

    if (this.ctx.mode.cordova || this.ctx.mode.capacitor) {
      cfg.build.packagedDistDir = path.join(cfg.build.distDir, this.ctx.targetName)
    }

    if (this.ctx.mode.cordova || this.ctx.mode.capacitor) {
      cfg.build.distDir = appPaths.resolve[ this.ctx.modeName ]('www')
    }
    else if (this.ctx.mode.electron || this.ctx.mode.bex) {
      cfg.build.packagedDistDir = cfg.build.distDir
      cfg.build.distDir = path.join(cfg.build.distDir, 'UnPackaged')
    }

    cfg.build.publicPath
      = cfg.build.publicPath && [ 'spa', 'pwa', 'ssr' ].includes(this.ctx.modeName)
        ? formatPublicPath(cfg.build.publicPath)
        : (cfg.build.vueRouterMode === 'hash' ? '' : '/')

    /* careful if you configure the following; make sure that you really know what you are doing */
    cfg.build.vueRouterBase = cfg.build.vueRouterBase !== void 0
      ? cfg.build.vueRouterBase
      : formatRouterBase(cfg.build.publicPath)

    /* careful if you configure the following; make sure that you really know what you are doing */
    cfg.build.appBase = cfg.build.appBase !== void 0
      ? cfg.build.appBase
      : cfg.build.publicPath

    cfg.sourceFiles = merge({
      rootComponent: 'src/App.vue',
      router: 'src/router/index',
      store: `src/${ storeProvider.pathKey }/index`,
      indexHtmlTemplate: 'src/index.template.html',
      registerServiceWorker: 'src-pwa/register-service-worker',
      serviceWorker: 'src-pwa/custom-service-worker',
      electronMain: 'src-electron/electron-main',
      electronPreload: 'src-electron/electron-preload'
    }, cfg.sourceFiles)

    appFilesValidations(cfg)

    cfg.__storePackage = storeProvider.name

    // do we have a store?
    const storePath = appPaths.resolve.app(cfg.sourceFiles.store)
    cfg.store = (
      existsSync(storePath)
      || existsSync(storePath + '.js')
      || existsSync(storePath + '.ts')
    )

    // make sure we have preFetch in config
    cfg.preFetch = cfg.preFetch || false

    if (this.ctx.mode.capacitor & cfg.capacitor.capacitorCliPreparationParams.length === 0) {
      cfg.capacitor.capacitorCliPreparationParams = [ 'sync', this.ctx.targetName ]
    }

    if (this.ctx.mode.ssr) {
      cfg.ssr = merge({
        pwa: false,
        manualStoreHydration: false,
        manualPostHydrationTrigger: false,
        prodPort: 3000, // gets superseded in production by an eventual process.env.PORT
        maxAge: 1000 * 60 * 60 * 24 * 30
      }, cfg.ssr)

      if (cfg.ssr.manualPostHydrationTrigger !== true) {
        cfg.__needsAppMountHook = true
      }

      if (cfg.ssr.middlewares.length > 0) {
        cfg.ssr.middlewares = cfg.ssr.middlewares.filter(_ => _)
          .map(parseAssetProperty('src-ssr/middlewares'))
          .filter(asset => asset.path)
          .filter(uniquePathFilter)
      }

      if (cfg.ssr.pwa) {
        const { installMissing } = require('./mode/install-missing.js')
        await installMissing('pwa')
        rawDefine.__QUASAR_SSR_PWA__ = true
      }

      this.ctx.mode.pwa = cfg.ctx.mode.pwa = !!cfg.ssr.pwa
    }

    if (this.ctx.dev) {
      const originalSetup = cfg.devServer.setupMiddlewares
      const openInEditor = require('launch-editor-middleware')

      if (this.ctx.mode.bex === true) {
        cfg.devServer.devMiddleware = cfg.devServer.devMiddleware || {}
        cfg.devServer.devMiddleware.writeToDisk = true
      }

      cfg.devServer = merge({
        hot: true,
        allowedHosts: 'all',
        compress: true,
        open: true,
        client: {
          overlay: {
            warnings: false
          }
        },
        server: {
          type: 'http'
        },
        devMiddleware: {
          publicPath: cfg.build.publicPath,
          stats: false
        }
      },
      this.ctx.mode.ssr === true
        ? {
            devMiddleware: {
              index: false
            },
            static: {
              serveIndex: false
            }
          }
        : {
            historyApiFallback: cfg.build.vueRouterMode === 'history'
              ? { index: `${ cfg.build.publicPath || '/' }${ cfg.build.htmlFilename }` }
              : false,
            devMiddleware: {
              index: cfg.build.htmlFilename
            }
          },
      cfg.devServer,
      {
        setupMiddlewares: (middlewares, opts) => {
          const { app } = opts

          if (!this.ctx.mode.ssr) {
            const express = require('express')

            if (cfg.build.ignorePublicFolder !== true) {
              app.use((cfg.build.publicPath || '/'), express.static(appPaths.resolve.app('public'), {
                maxAge: 0
              }))
            }

            if (this.ctx.mode.cordova) {
              const folder = appPaths.resolve.cordova(`platforms/${ this.ctx.targetName }/platform_www`)
              app.use('/', express.static(folder, { maxAge: 0 }))
            }
          }

          app.use('/__open-in-editor', openInEditor(void 0, appPaths.appDir))

          return originalSetup
            ? originalSetup(middlewares, opts)
            : middlewares
        }
      })

      // (backward compatibility for upstream)
      // webpack-dev-server 4.5.0 introduced a change in behavior
      // along with deprecation notices; so we transform it automatically
      // for a better experience for our developers
      if (cfg.devServer.https !== void 0) {
        const { https } = cfg.devServer

        delete cfg.devServer.https

        if (https !== false) {
          cfg.devServer.server = {
            type: 'https'
          }

          if (Object(https) === https) {
            cfg.devServer.server.options = https
          }
        }
      }

      if (this.ctx.vueDevtools === true || cfg.devServer.vueDevtools === true) {
        cfg.__needsAppMountHook = true
        cfg.__vueDevtools = {
          host: cfg.devServer.host === '0.0.0.0' ? 'localhost' : cfg.devServer.host,
          port: 8098
        }
      }

      // make sure the prop is not supplied to webpack dev server
      if (cfg.devServer.vueDevtools !== void 0) {
        delete cfg.devServer.vueDevtools
      }

      if (this.ctx.mode.cordova || this.ctx.mode.capacitor || this.ctx.mode.electron) {
        cfg.devServer.open = false

        if (this.ctx.mode.electron) {
          cfg.devServer.server.type = 'http'
        }
      }

      if (cfg.devServer.open) {
        const { isMinimalTerminal } = require('./utils/is-minimal-terminal.js')
        if (isMinimalTerminal) {
          cfg.devServer.open = false
        }
      }

      if (cfg.devServer.open) {
        cfg.__devServer = {
          open: !!cfg.devServer.open,
          openOptions: cfg.devServer.open !== true
            ? cfg.devServer.open
            : false
        }
        cfg.devServer.open = false
      }
      else {
        cfg.__devServer = {}
      }
    }

    if (cfg.build.gzip) {
      const gzip = cfg.build.gzip === true
        ? {}
        : cfg.build.gzip
      let ext = [ 'js', 'css' ]

      if (gzip.extensions) {
        ext = gzip.extensions
        delete gzip.extensions
      }

      cfg.build.gzip = merge({
        algorithm: 'gzip',
        test: new RegExp('\\.(' + ext.join('|') + ')$'),
        threshold: 10240,
        minRatio: 0.8
      }, gzip)
    }

    if (this.ctx.mode.pwa) {
      cfg.pwa = merge({
        workboxPluginMode: 'GenerateSW',
        workboxOptions: {},
        useCredentials: false,
        manifest: {
          name: appPkg.productName || appPkg.name || 'Quasar App',
          short_name: appPkg.name || 'quasar-pwa',
          description: appPkg.description,
          display: 'standalone',
          start_url: '.'
        },
        metaVariables: {
          appleMobileWebAppCapable: 'yes',
          appleMobileWebAppStatusBarStyle: 'default',
          appleTouchIcon120: 'icons/apple-icon-120x120.png',
          appleTouchIcon152: 'icons/apple-icon-152x152.png',
          appleTouchIcon167: 'icons/apple-icon-167x167.png',
          appleTouchIcon180: 'icons/apple-icon-180x180.png',
          appleSafariPinnedTab: 'icons/safari-pinned-tab.svg',
          msapplicationTileImage: 'icons/ms-icon-144x144.png',
          msapplicationTileColor: '#000000'
        }
      }, cfg.pwa)

      if (cfg.pwa.manifest.icons.length === 0) {
        warn()
        warn('PWA manifest in quasar.config file > pwa > manifest is missing "icons" prop.\n')
        process.exit(1)
      }

      if (![ 'GenerateSW', 'InjectManifest' ].includes(cfg.pwa.workboxPluginMode)) {
        warn()
        warn(`Workbox webpack plugin mode "${ cfg.pwa.workboxPluginMode }" is invalid.`)
        warn('Valid Workbox modes are: GenerateSW, InjectManifest\n')
        process.exit(1)
      }

      cfg.pwa.manifest.icons = cfg.pwa.manifest.icons.map(icon => {
        if (urlRegex.test(icon.src) === false) {
          icon.src = `${ cfg.build.publicPath }${ icon.src }`
        }
        return icon
      })
    }

    if (this.ctx.dev) {
      const urlPath = cfg.build.vueRouterMode === 'hash'
        ? (cfg.build.htmlFilename !== 'index.html' ? (cfg.build.publicPath ? '' : '/') + cfg.build.htmlFilename : '')
        : ''

      cfg.__getUrl = hostname => `http${ cfg.devServer.server.type === 'https' ? 's' : '' }://${ hostname }:${ cfg.devServer.port }${ cfg.build.publicPath }${ urlPath }`
      cfg.build.APP_URL = cfg.__getUrl(
        cfg.devServer.host === '0.0.0.0'
          ? 'localhost'
          : cfg.devServer.host
      )
    }
    else if (this.ctx.mode.cordova || this.ctx.mode.capacitor || this.ctx.mode.bex) {
      cfg.build.APP_URL = 'index.html'
    }
    else if (this.ctx.mode.electron) {
      rawDefine[ 'process.env.APP_URL' ] = '"file://" + __dirname + "/index.html"'
    }

    cfg.build.rawDefine = {
      ...rawDefine,
      ...cfg.build.rawDefine
    }

    Object.assign(cfg.build.env, {
      NODE_ENV: this.ctx.prod ? 'production' : 'development',
      CLIENT: true,
      SERVER: false,
      DEV: this.ctx.dev,
      PROD: this.ctx.prod,
      DEBUGGING: this.ctx.debug || this.ctx.dev,
      MODE: this.ctx.modeName,
      VUE_ROUTER_MODE: cfg.build.vueRouterMode,
      VUE_ROUTER_BASE: cfg.build.vueRouterBase,
      APP_URL: cfg.build.APP_URL
    })

    if (this.ctx.mode.pwa) {
      cfg.build.env.SERVICE_WORKER_FILE = `${ cfg.build.publicPath }service-worker.js`
    }
    else if (this.ctx.mode.bex) {
      cfg.bex = merge({}, cfg.bex, {
        builder: {
          directories: {
            input: cfg.build.distDir,
            output: path.join(cfg.build.packagedDistDir, 'Packaged')
          }
        }
      })
    }
    else if (this.ctx.mode.electron && this.ctx.prod) {
      const bundler = require('./electron/bundler.js')

      const icon = appPaths.resolve.electron('icons/icon.png')
      const builderIcon = process.platform === 'linux'
        // backward compatible (linux-512x512.png)
        ? (existsSync(icon) === true ? icon : appPaths.resolve.electron('icons/linux-512x512.png'))
        : appPaths.resolve.electron('icons/icon')

      cfg.electron = merge({
        packager: {
          asar: true,
          icon: appPaths.resolve.electron('icons/icon'),
          overwrite: true
        },
        builder: {
          appId: 'quasar-app',
          icon: builderIcon,
          productName: appPkg.productName || appPkg.name || 'Quasar App',
          directories: {
            buildResources: appPaths.resolve.electron('')
          }
        }
      }, cfg.electron, {
        packager: {
          dir: cfg.build.distDir,
          out: cfg.build.packagedDistDir
        },
        builder: {
          directories: {
            app: cfg.build.distDir,
            output: path.join(cfg.build.packagedDistDir, 'Packaged')
          }
        }
      })

      if (cfg.ctx.bundlerName) {
        cfg.electron.bundler = cfg.ctx.bundlerName
      }
      else if (!cfg.electron.bundler) {
        cfg.electron.bundler = bundler.getDefaultName()
      }

      if (this.opts.argv !== void 0) {
        const { ensureElectronArgv } = require('./utils/ensure-argv.js')
        ensureElectronArgv(cfg.electron.bundler, this.opts.argv)
      }

      if (cfg.electron.bundler === 'packager') {
        if (cfg.ctx.targetName) {
          cfg.electron.packager.platform = cfg.ctx.targetName
        }
        if (cfg.ctx.archName) {
          cfg.electron.packager.arch = cfg.ctx.archName
        }
      }
      else {
        cfg.electron.builder = {
          config: cfg.electron.builder
        }

        if (cfg.ctx.targetName === 'mac' || cfg.ctx.targetName === 'darwin' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.mac = []
        }

        if (cfg.ctx.targetName === 'linux' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.linux = []
        }

        if (cfg.ctx.targetName === 'win' || cfg.ctx.targetName === 'win32' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.win = []
        }

        if (cfg.ctx.archName) {
          cfg.electron.builder[ cfg.ctx.archName ] = true
        }

        if (cfg.ctx.publish) {
          cfg.electron.builder.publish = cfg.ctx.publish
        }
      }

      bundler.ensureInstall(cfg.electron.bundler)
    }

    cfg.htmlVariables = merge({
      ctx: cfg.ctx,
      process: {
        env: cfg.build.env
      },
      productName: escapeHTMLTagContent(cfg.build.productName),
      productDescription: escapeHTMLAttribute(cfg.build.productDescription)
    }, cfg.htmlVariables)

    cfg.__html = {
      minifyOptions: cfg.build.minify
        ? {
            removeComments: true,
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            collapseBooleanAttributes: true,
            removeScriptTypeAttributes: true
          // more options:
          // https://github.com/kangax/html-minifier#options-quick-reference
          }
        : false
    }

    // used by .quasar entry templates
    cfg.__versions = {}
    cfg.__css = {
      quasarSrcExt: cssVariables.quasarSrcExt
    }

    if (this.ctx.mode.capacitor) {
      const { capVersion } = require('./capacitor/cap-cli.js')
      cfg.__versions.capacitor = capVersion

      const getCapPluginVersion = capVersion <= 2
        ? () => true
        : name => {
          const version = getPackageMajorVersion(name, appPaths.capacitorDir)
          return version === void 0
            ? false
            : version || true
        }

      Object.assign(cfg.__versions, {
        capacitor: capVersion,
        capacitorPluginApp: getCapPluginVersion('@capacitor/app'),
        capacitorPluginSplashscreen: getCapPluginVersion('@capacitor/splash-screen')
      })
    }
    else if (this.ctx.mode.pwa) {
      cfg.__versions.workboxWebpackPlugin = getPackageMajorVersion('workbox-webpack-plugin')
    }

    if (this.ctx.mode.capacitor && cfg.__versions.capacitorPluginSplashscreen && cfg.capacitor.hideSplashscreen !== false) {
      cfg.__needsAppMountHook = true
    }

    cfg.__fileEnv = readFileEnv({
      quasarMode: this.ctx.modeName,
      buildType: this.ctx.dev ? 'dev' : 'prod',
      envFolder: cfg.build.envFolder,
      envFiles: cfg.build.envFiles
    })

    this.quasarConf = cfg

    if (this.#webpackConfChanged !== false) {
      this.webpackConf = await createWebpackConfig(cfg)
    }

    return {
      quasarConf: this.quasarConf,
      webpackConf: this.webpackConf
    }
  }
}
