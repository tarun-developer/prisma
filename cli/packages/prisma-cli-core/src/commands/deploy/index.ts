import { Command, flags, Flags, DeployPayload, Config } from 'prisma-cli-engine'
import { Cluster } from 'prisma-yml'
import chalk from 'chalk'
import * as chokidar from 'chokidar'
import * as inquirer from 'inquirer'
import * as path from 'path'
import * as fs from 'fs-extra'
import { fetchAndPrintSchema } from './printSchema'
import { Seeder } from '../seed/Seeder'
import * as semver from 'semver'
const debug = require('debug')('deploy')
import { prettyTime, concatName, defaultDockerCompose } from '../../util'
import * as sillyname from 'sillyname'
import { getSchemaPathFromConfig } from './getSchemaPathFromConfig'
import { EndpointDialog } from '../../utils/EndpointDialog'
import { spawnSync } from 'npm-run'
import * as figures from 'figures'

export default class Deploy extends Command {
  static topic = 'deploy'
  static description = 'Deploy service changes (or new service)'
  static group = 'general'
  static allowAnyFlags = true
  static help = `
  
  ${chalk.green.bold('Examples:')}
      
${chalk.gray(
    '-',
  )} Deploy local changes from prisma.yml to the default service environment.
  ${chalk.green('$ prisma deploy')}
    
${chalk.gray(
    '-',
  )} Deploy local changes from default service file accepting potential data loss caused by schema changes
  ${chalk.green('$ prisma deploy --force')}
  `
  static flags: Flags = {
    force: flags.boolean({
      char: 'f',
      description: 'Accept data loss caused by schema changes',
    }),
    watch: flags.boolean({
      char: 'w',
      description: 'Watch for changes',
    }),
    new: flags.boolean({
      char: 'n',
      description: 'Force interactive mode to select the cluster',
    }),
    'dry-run': flags.boolean({
      char: 'd',
      description: 'Perform a dry-run of the deployment',
    }),
    'no-seed': flags.boolean({
      description: 'Disable seed on initial service deploy',
    }),
    json: flags.boolean({
      char: 'j',
      description: 'Json Output',
    }),
    ['env-file']: flags.string({
      description: 'Path to .env file to inject env vars',
      char: 'e',
    }),
  }
  private deploying: boolean = false
  private showedHooks: boolean = false
  private loggedIn: boolean = false
  async run() {
    /**
     * Get Args
     */
    const { force, watch } = this.flags
    const interactive = this.flags.new // new is a reserved keyword, so we use interactive instead
    const envFile = this.flags['env-file']
    const dryRun = this.flags['dry-run']

    if (envFile && !fs.pathExistsSync(path.join(this.config.cwd, envFile))) {
      await this.out.error(`--env-file path '${envFile}' does not exist`)
    }

    /**
     * Get prisma.yml content
     */
    await this.definition.load(this.flags, envFile)

    let serviceName = this.definition.service!
    let stage = this.definition.stage!

    /**
     * If no endpoint or service provided, ask for it
     */
    let workspace: string | undefined | null = this.definition.getWorkspace()
    let cluster
    let dockerComposeYml = defaultDockerCompose
    if (!serviceName || !stage || interactive) {
      const endpointDialog = new EndpointDialog(
        this.out,
        this.client,
        this.env,
        this.config,
      )
      const results = await endpointDialog.getEndpoint()
      cluster = results.cluster
      workspace = results.workspace
      serviceName = results.service
      stage = results.stage
      dockerComposeYml = results.dockerComposeYml
      this.definition.replaceEndpoint(results.endpoint)
      // Reload definition because we are changing the yml file
      await this.definition.load(this.flags, envFile)
      this.out.log(
        `\nWritten endpoint \`${chalk.bold(
          results.endpoint,
        )}\` to prisma.yml\n`,
      )
    } else {
      cluster = this.definition.getCluster(false)
    }

    if (
      cluster &&
      cluster.local &&
      !await cluster.isOnline()
    ) {
      throw new Error(
        `Could not connect to server at ${
          cluster.baseUrl
        }. Please check if your server is running.`,
      )
    }

    /**
     * If the cluster has been provided with the old "cluster: " key, check if the cluster could be found
     */
    if (this.definition.definition!.cluster && !cluster) {
      this.out.log(
        `You're not logged in and cluster ${chalk.bold(
          this.definition.definition!.cluster!,
        )} could not be found locally. Trying to authenticate.\n`,
      )
      // signs in and fetches clusters
      await this.client.login()
      cluster = this.definition.getCluster()
    }

    /**
     * Abort when no cluster is set
     */
    if (cluster) {
      this.env.setActiveCluster(cluster)
    } else {
      throw new Error(`Cluster ${cluster} does not exist.`)
    }

    /**
     * Make sure we're logged in when a non-public cluster has been chosen
     */
    if (cluster && !cluster.local && cluster.isPrivate) {
      if (!workspace) {
        workspace = this.definition.getWorkspace()
      }
      if (
        workspace &&
        !workspace.startsWith('public-') &&
        (!this.env.cloudSessionKey || this.env.cloudSessionKey === '')
      ) {
        await this.client.login()
        cluster.clusterSecret = this.env.cloudSessionKey
      }
    }

    await this.client.initClusterClient(cluster, serviceName, stage, workspace!)

    let projectNew = false
    debug('checking if project exists')
    if (!await this.projectExists(cluster, serviceName, stage, workspace!)) {
      debug('adding project')
      await this.addProject(cluster, serviceName, stage, workspace!)
      projectNew = true
    }

    await this.deploy(
      stage,
      serviceName,
      cluster,
      cluster.name,
      force,
      dryRun,
      projectNew,
      workspace!,
    )

    if (watch) {
      this.out.log('Watching for change...')
      chokidar
        .watch(this.config.definitionDir, { ignoreInitial: true })
        .on('all', () => {
          setImmediate(async () => {
            if (!this.deploying) {
              await this.definition.load(this.flags)
              await this.deploy(
                stage,
                serviceName,
                cluster,
                cluster.name,
                force,
                dryRun,
                false,
                workspace!,
              )
              this.out.log('Watching for change...')
            }
          })
        })
    }
  }
  
  private getSillyName() {
    return `${slugify(sillyname()).split('-')[0]}-${Math.round(
      Math.random() * 1000,
    )}`
  }

  private getPublicName() {
    return `public-${this.getSillyName()}`
  }

  private async projectExists(
    cluster: Cluster,
    name: string,
    stage: string,
    workspace: string | null,
  ): Promise<boolean> {
    try {
      return Boolean(
        await this.client.getProject(
          concatName(cluster, name, workspace),
          stage,
        ),
      )
    } catch (e) {
      return false
    }
  }

  private async addProject(
    cluster: Cluster,
    name: string,
    stage: string,
    workspace: string | null,
  ): Promise<void> {
    this.out.action.start(`Creating stage ${stage} for service ${name}`)
    const createdProject = await this.client.addProject(
      concatName(cluster, name, workspace),
      stage,
      this.definition.secrets,
    )
    this.out.action.stop()
  }

  private async deploy(
    stageName: string,
    serviceName: string,
    cluster: Cluster,
    completeClusterName: string,
    force: boolean,
    dryRun: boolean,
    projectNew: boolean,
    workspace: string | null,
  ): Promise<void> {
    this.deploying = true
    let before = Date.now()

    const b = s => `\`${chalk.bold(s)}\``

    const verb = dryRun ? 'Performing dry run for' : 'Deploying'

    this.out.action.start(
      `${verb} service ${b(serviceName)} to stage ${b(stageName)} to server ${b(
        completeClusterName,
      )}`,
    )

    const migrationResult: DeployPayload = await this.client.deploy(
      concatName(cluster, serviceName, workspace),
      stageName,
      this.definition.typesString!,
      dryRun,
      this.definition.getSubscriptions(),
      this.definition.secrets,
      force,
    )
    this.out.action.stop(prettyTime(Date.now() - before))
    this.printResult(migrationResult, force)

    if (
      migrationResult.migration &&
      migrationResult.migration.revision > 0 &&
      !dryRun
    ) {
      before = Date.now()
      this.out.action.start(
        `Applying changes`,
        this.getProgress(0, migrationResult.migration.steps.length),
      )
      let done = false
      while (!done) {
        const revision = migrationResult.migration.revision
        const migration = await this.client.getMigration(
          concatName(cluster, serviceName, workspace),
          stageName,
        )

        if (migration.errors && migration.errors.length > 0) {
          await this.out.error(migration.errors.join('\n'))
        }

        if (migration.applied === migrationResult.migration.steps.length) {
          done = true
        }
        this.out.action.status = this.getProgress(
          migration.applied,
          migrationResult.migration.steps.length,
        )
        await new Promise(r => setTimeout(r, 500))
      }

      this.out.action.stop(prettyTime(Date.now() - before))
    }
    // TODO move up to if statement after testing done
    if (migrationResult.migration) {
      if (
        this.definition.definition!.seed &&
        !this.flags['no-seed'] &&
        projectNew
      ) {
        this.printHooks()
        await this.seed(
          cluster,
          projectNew,
          serviceName,
          stageName,
          this.definition.getWorkspace(),
        )
      }

      // no action required
      this.deploying = false
      if (migrationResult.migration) {
        this.printEndpoints(
          cluster,
          serviceName,
          stageName,
          this.definition.getWorkspace() || undefined,
        )
      }
    }
    const hooks = this.definition.getHooks('post-deploy')
    if (hooks.length > 0) {
      this.out.log(`\n${chalk.bold('post-deploy')}:`)
    }
    for (const hook of hooks) {
      const splittedHook = hook.split(' ')
      this.out.action.start(`Running ${chalk.cyan(hook)}`)
      const child = spawnSync(splittedHook[0], splittedHook.slice(1))
      const stderr = child.stderr && child.stderr.toString()
      if (stderr && stderr.length > 0) {
        this.out.log(chalk.red(stderr))
      }
      const stdout = child.stdout && child.stdout.toString()
      if (stdout && stdout.length > 0) {
        this.out.log(stdout)
      }
      const { status, error } = child
      if (error || status != 0) {
        if (error) {
          this.out.log(chalk.red(error.message))
        }
        this.out.action.stop(chalk.red(figures.cross))
      } else {
        this.out.action.stop()
      }
    }
  }

  private printHooks() {
    if (!this.showedHooks) {
      this.out.log(chalk.bold(`\nHooks:`))
      this.showedHooks = true
    }
  }

  private getProgress(applied: number, of: number) {
    return this.out.color.prisma(`(${applied}/${of})`)
  }

  private async seed(
    cluster: Cluster,
    projectNew: boolean,
    serviceName: string,
    stageName: string,
    workspace: string | null,
  ) {
    const seeder = new Seeder(
      this.definition,
      this.client,
      this.out,
      this.config,
    )
    const before = Date.now()
    const from =
      this.definition.definition!.seed &&
      this.definition.definition!.seed!.import
        ? ` from \`${this.definition.definition!.seed!.import}\``
        : ''
    this.out.action.start(`Importing seed dataset${from}`)
    await seeder.seed(concatName(cluster, serviceName, workspace), stageName)
    this.out.action.stop(prettyTime(Date.now() - before))
  }

  /**
   * Returns true if there was a change
   */
  private async generateSchema(
    cluster: Cluster,
    serviceName: string,
    stageName: string,
  ): Promise<boolean> {
    const schemaPath =
      getSchemaPathFromConfig() || this.definition.definition!.schema
    if (schemaPath) {
      this.printHooks()
      const schemaDir = path.dirname(schemaPath)
      fs.mkdirpSync(schemaDir)
      const token = this.definition.getToken(serviceName, stageName)
      const before = Date.now()
      this.out.action.start(`Checking, if schema file changed`)
      const schemaString = await fetchAndPrintSchema(
        this.client,
        concatName(cluster, serviceName, this.definition.getWorkspace()),
        stageName,
        token,
      )
      this.out.action.stop(prettyTime(Date.now() - before))
      const oldSchemaString = fs.pathExistsSync(schemaPath)
        ? fs.readFileSync(schemaPath, 'utf-8')
        : null
      if (schemaString !== oldSchemaString) {
        const beforeWrite = Date.now()
        this.out.action.start(`Writing database schema to \`${schemaPath}\` `)
        fs.writeFileSync(schemaPath, schemaString)
        this.out.action.stop(prettyTime(Date.now() - beforeWrite))
        return true
      }
    }

    return false
  }

  private printResult(payload: DeployPayload, force: boolean) {
    if (payload.errors && payload.errors.length > 0) {
      this.out.log(`${chalk.bold.red('\nErrors:')}`)
      this.out.migration.printErrors(payload.errors)
      this.out.log(
        '\nDeployment canceled. Please fix the above errors to continue deploying.',
      )
      this.out.log(
        'Read more about deployment errors here: https://bit.ly/prisma-force-flag',
      )

      this.out.exit(1)
    }

    if (payload.warnings && payload.warnings.length > 0) {
      this.out.log(`${chalk.bold.yellow('\nWarnings:')}`)
      this.out.migration.printWarnings(payload.warnings)

      if (force) {
        this.out.log('\nIgnoring warnings because you provided --force.')
      } else {
        this.out.log(
          `\nIf you want to ignore the warnings, please deploy with the --force flag: ${chalk.cyan(
            '$ prisma deploy --force',
          )}`,
        )
        this.out.log(
          'Read more about deployment warnings here: https://bit.ly/prisma-force-flag',
        )
        this.out.exit(1)
      }
    }

    if (!payload.migration || payload.migration.steps.length === 0) {
      this.out.log('Service is already up to date.')
      return
    }

    if (payload.migration.steps.length > 0) {
      // this.out.migrati
      this.out.log('\n' + chalk.bold('Changes:'))
      this.out.migration.printMessages(payload.migration.steps)
      this.out.log('')
    }
  }

  private printEndpoints(
    cluster: Cluster,
    serviceName: string,
    stageName: string,
    workspace?: string,
  ) {
    this.out.log(`\n${chalk.bold(
      'Your Prisma GraphQL database endpoint is live:',
    )}

  ${chalk.bold('HTTP:')}  ${cluster.getApiEndpoint(
      serviceName,
      stageName,
      workspace,
    )}
  ${chalk.bold('WS:')}    ${cluster.getWSEndpoint(
      serviceName,
      stageName,
      workspace,
    )}
`)
  }

  private getCloudClusters(): Cluster[] {
    return this.env.clusters.filter(c => c.shared || c.isPrivate)
  }

  private async clusterSelection(loggedIn: boolean): Promise<string> {
    debug({ loggedIn })

    const choices = loggedIn
      ? await this.getLoggedInChoices()
      : this.getPublicChoices()

    const question = {
      name: 'cluster',
      type: 'list',
      message: `Please choose the cluster you want to deploy to`,
      choices,
      pageSize: 9,
    }

    const { cluster } = await this.out.prompt(question)

    if (cluster === 'login') {
      await this.client.login()
      this.loggedIn = true
      return this.clusterSelection(true)
    }

    return cluster
  }

  private getLocalClusterChoices(): string[][] {
    // const clusters = this.env.clusters.filter(c => !c.shared && !c.isPrivate)

    // const clusterNames: string[][] = clusters.map(c => {
    //   const note =
    //     c.baseUrl.includes('localhost') || c.baseUrl.includes('127.0.0.1')
    //       ? 'Local cluster (requires Docker)'
    //       : 'Self-hosted'
    //   return [c.name, note]
    // })

    // if (clusterNames.length === 0) {
    //   clusterNames.push(['local', 'Local cluster (requires Docker)'])
    // }
    // return clusterNames
    return [['local', 'Local cluster (requires Docker)']]
  }

  private async getLoggedInChoices(): Promise<any[]> {
    const localChoices = this.getLocalClusterChoices()
    // const workspaces = await this.client.getWorkspaces()
    // const clusters = this.env.clusters.filter(
    //   c => c.shared && c.name !== 'shared-public-demo',
    // )
    const combinations: string[][] = []
    const remoteClusters = this.env.clusters.filter(
      c => c.shared || c.isPrivate,
    )

    remoteClusters.forEach(cluster => {
      const label = this.env.sharedClusters.includes(cluster.name)
        ? 'Free development cluster (hosted on Prisma Cloud)'
        : 'Private Prisma Cluster'
      combinations.push([`${cluster.workspaceSlug}/${cluster.name}`, label])
    })

    const allCombinations = [...combinations, ...localChoices]

    return [
      new inquirer.Separator('                     '),
      ...this.convertChoices(allCombinations),
      new inquirer.Separator('                     '),
      new inquirer.Separator(
        chalk.dim(
          `You can learn more about deployment in the docs: http://bit.ly/prisma-graphql-deployment`,
        ),
      ),
    ]
  }

  private convertChoices(
    choices: string[][],
  ): Array<{ value: string; name: string }> {
    const padded = this.out.printPadded(choices, 0, 6).split('\n')
    return padded.map((name, index) => ({
      name,
      value: choices[index][0],
    }))
  }

  private getPublicChoices(): any[] {
    const publicChoices = [
      [
        'prisma-eu1',
        'Public development cluster (hosted in EU on Prisma Cloud)',
      ],
      [
        'prisma-us1',
        'Public development cluster (hosted in US on Prisma Cloud)',
      ],
    ]
    const allCombinations = [...publicChoices, ...this.getLocalClusterChoices()]

    return [
      ...this.convertChoices(allCombinations),
      new inquirer.Separator('                     '),
      {
        value: 'login',
        name: 'Log in or create new account on Prisma Cloud',
      },
      new inquirer.Separator('                     '),
      new inquirer.Separator(
        chalk.dim(
          `Note: When not logged in, service deployments to Prisma Cloud expire after 7 days.`,
        ),
      ),
      new inquirer.Separator(
        chalk.dim(
          `You can learn more about deployment in the docs: http://bit.ly/prisma-graphql-deployment`,
        ),
      ),
      new inquirer.Separator('                     '),
    ]
  }
}

export function isValidProjectName(projectName: string): boolean {
  return /^[A-Z](.*)/.test(projectName)
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w\-]+/g, '') // Remove all non-word chars
    .replace(/\-\-+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, '') // Trim - from end of text
}
