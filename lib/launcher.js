const fs = require('fs')
const path = require('path')
const got = require('got')
const childProcess = require('child_process')
const LogBuffer = require('./logBuffer')
const { getSettingsFile } = require('./runtimeSettings')

const MIN_RESTART_TIME = 10000 // 10 seconds
const MAX_RESTART_COUNT = 5

const States = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    SAFE: 'safe',
    CRASHED: 'crashed',
    STOPPING: 'stopping'
}
/**
 * options:
 *  - logBufferMax
 *  - forgeURL
 *  - project
 *  - token
 *  - execPath
 */
class Launcher {
    constructor (options) {
        this.options = options
        this.state = States.STOPPED
        // Assume we want to start NR unless told otherwise via loadSettings
        this.targetState = States.RUNNING
        this.env = {
            PATH: process.env.PATH
        }
        this.settings = null
        this.startTime = []
        this.restartCount = 0
        this.logBuffer = new LogBuffer(this.options.logBufferMax || 1000)
        this.logBuffer.add({ level: 'system', msg: 'Launcher Started' })
    }

    async loadSettings () {
        this.logBuffer.add({ level: 'system', msg: 'Loading project settings' })
        const settingsURL = `${this.options.forgeURL}/api/v1/projects/${this.options.project}/settings`
        const newSettings = await got(settingsURL, {
            headers: {
                authorization: `Bearer ${this.options.token}`
            }
        }).json()

        this.settings = newSettings
        this.settings.projectToken = this.options.token
        this.settings.clientID = process.env.FORGE_CLIENT_ID
        this.settings.clientSecret = process.env.FORGE_CLIENT_SECRET
        this.settings.credentialSecret = process.env.FORGE_NR_SECRET

        // setup nodeDir to include the path to additional nodes and plugins
        const nodesDir = []
        if (Array.isArray(this.settings.nodesDir) && this.settings.nodesDir.length) {
            nodesDir.push(...this.settings.nodesDir)
        } else if (this.settings.nodesDir && typeof this.settings.nodesDir === 'string') {
            nodesDir.push(this.settings.nodesDir)
        }
        nodesDir.push(path.join(require.main.path, 'node_modules', '@flowforge', 'nr-theme').replace(/\\/g, '/')) // MVP: fixed to loading FF theme
        nodesDir.push(path.join(require.main.path, '..', 'nr-theme').replace(/\\/g, '/')) // MVP: fixed to loading FF theme
        this.settings.nodesDir = nodesDir

        const settingsFileContent = getSettingsFile(this.settings)
        const settingsPath = path.join(this.settings.rootDir, this.settings.userDir, 'settings.js')
        fs.writeFileSync(settingsPath, settingsFileContent)

        this.targetState = this.settings.state || States.RUNNING
        this.logBuffer.add({ level: 'system', msg: `Target state is '${this.targetState}'` })
    }

    async logAuditEvent (event) {
        return got.post(this.options.forgeURL + '/logging/' + this.options.project + '/audit', {
            json: {
                timestamp: Date.now(),
                event: event
            },
            headers: {
                authorization: 'Bearer ' + this.options.token
            }
        // eslint-disable-next-line node/handle-callback-err
        }).catch(err => {})
    }

    getState () {
        return this.state
    }

    getLastStartTime () {
        return this.startTime.length !== 0 ? this.startTime[this.startTime.length - 1] : -1
    }

    getLog () {
        return this.logBuffer
    }

    isHealthy () {
        return this.proc && this.proc.exitCode === null
    }

    async start (targetState) {
        if (targetState) {
            this.targetState = targetState
        }
        if (!this.settings) {
            throw new Error('Failed to load settings')
        }
        if (this.state === States.RUNNING) {
            // Already running - no need to start again
            return
        }
        if (this.targetState === States.STOPPED) {
            // Target state is stopped - don't start
            return
        }
        this.logBuffer.add({ level: 'system', msg: 'Starting Node-RED' })
        const appEnv = Object.assign({}, this.env, this.settings.env)

        if (this.targetState === States.SAFE) {
            appEnv.NODE_RED_ENABLE_SAFE_MODE = true
        }

        appEnv.NODE_PATH = [
            path.join(require.main.path, 'node_modules'),
            path.join(require.main.path, '..', '..')
        ].join(path.delimiter)

        const processOptions = {
            windowsHide: true,
            env: appEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: path.join(this.settings.rootDir, this.settings.userDir)
        }

        const processArguments = [
            '-u',
            path.join(this.settings.rootDir, this.settings.userDir),
            '-p',
            this.settings.port
        ]

        if (this.settings.stack?.memory && /^[1-9]\d*$/.test(this.settings.stack.memory)) {
            const memLimit = Math.round(this.settings.stack.memory * 0.75)
            processArguments.push(`--max-old-space-size=${memLimit}`)
        }
        this.options.execPathJs = path.join(this.options.nodeRedPath, 'node_modules', 'node-red', 'red.js')
        processArguments.unshift(this.options.execPathJs)
        this.options.execPath = process.execPath
        this.proc = childProcess.spawn(
            this.options.execPath,
            processArguments,
            processOptions
        )

        this.state = States.STARTING

        this.proc.on('spawn', () => {
            // only works at NodeJS 16+
            // this.proc.pid
            this.state = States.RUNNING
            this.startTime.push(Date.now())
            if (this.startTime.length > MAX_RESTART_COUNT) {
                this.startTime.shift()
            }
        })

        this.proc.on('close', (code, signal) => {
            // console.log("node-red closed with", {code,signal})
        })

        this.proc.on('exit', async (code, signal) => {
            this.logBuffer.add({ level: 'system', msg: `Node-RED exited rc=${code} signal=${signal}` })
            // When childProcess.kill() is executed on windows, the exit code is null and the signal is 'SIGTERM'.
            // So long as the process was instructed to STOP and its state is STOPPED, consider this a clean exit
            if (process.platform === 'win32' && code === null && signal === 'SIGTERM' && this.targetState === States.STOPPED && this.state === States.STOPPED) {
                code = 0
            }
            if (code === 0) {
                this.state = States.STOPPED
                await this.logAuditEvent('stopped')
            } else {
                this.state = States.CRASHED
                await this.logAuditEvent('crashed')

                if (this.startTime.length === MAX_RESTART_COUNT) {
                    // check restart interval
                    let avg = 0
                    for (let i = this.startTime.length - 1; i > 0; i--) {
                        avg += (this.startTime[i] - this.startTime[i - 1])
                    }
                    avg /= MAX_RESTART_COUNT
                    if (avg < MIN_RESTART_TIME) {
                        // restarting too fast - go to safe mode
                        // reset the startTime list
                        this.startTime = []
                        if (this.targetState === States.SAFE) {
                            this.logBuffer.add({ level: 'system', msg: 'Node-RED restart loop detected whilst in safe mode. Stopping.' })
                            this.targetState = States.STOPPED
                        } else {
                            this.logBuffer.add({ level: 'system', msg: 'Node-RED restart loop detected. Restarting in safe mode' })
                            this.targetState = States.SAFE
                            this.start()
                        }
                    } else {
                        this.start()
                    }
                } else {
                    this.start()
                }
            }
        })

        this.proc.on('error', (err) => {
            this.logBuffer.add({ level: 'system', msg: `Error with Node-RED process: ${err.toString()}` })
            console.log('Process error: ' + err.toString())
        })

        let stdoutBuffer = ''
        this.proc.stdout.on('data', (data) => {
            // Do not assume `data` is a complete log record.
            // Parse until newline
            stdoutBuffer = stdoutBuffer + data
            let linebreak = stdoutBuffer.indexOf('\n')
            while (linebreak > -1) {
                const line = stdoutBuffer.substring(0, linebreak)
                if (line.length > 0) {
                    if (line[0] === '{' && line[line.length - 1] === '}') {
                        // In case something console.log's directly, we can't assume the line is JSON
                        // from our logger
                        try {
                            this.logBuffer.add(JSON.parse(line))
                        } catch (err) {
                            this.logBuffer.add({ msg: line })
                        }
                    } else {
                        this.logBuffer.add({ msg: line })
                    }
                }
                stdoutBuffer = stdoutBuffer.substring(linebreak + 1)
                linebreak = stdoutBuffer.indexOf('\n')
            }
        })
    }

    async stop () {
        this.logBuffer.add({ level: 'system', msg: 'Stopping Node-RED' })
        this.targetState = States.STOPPED
        if (this.proc) {
            this.state = States.STOPPED
            this.proc.kill()
            // TODO: block until proc has actually stopped
            this.proc.unref()
            this.proc = undefined
        } else {
            this.state = States.STOPPED
        }
    }

    async revokeUserToken (token) { // logout:nodered(step-5)
        this.logBuffer.add({ level: 'system', msg: 'Node-RED logout requested' })
        if (this.state !== States.RUNNING) {
            // not running
            return
        }
        try {
            const adminAPI = `${this.settings.baseURL}/auth/revoke`
            const json = { token: token, noRedirect: true }
            const headers = {
                authorization: 'Bearer ' + token,
                'cache-control': 'no-cache',
                'content-type': 'application/json',
                'node-red-api-version': 'v2',
                pragma: 'no-cache',
                Referer: this.settings.baseURL
            }
            await got.post(adminAPI, { json, headers })
        } catch (error) {
            this.logBuffer.add({ level: 'system', msg: `Error logging out Node-RED: ${error.toString()}` })
        }
    }
}

module.exports = { Launcher, States }
