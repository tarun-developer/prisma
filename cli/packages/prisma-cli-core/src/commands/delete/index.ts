import { Command, flags, Flags, Project } from 'prisma-cli-engine'
import chalk from 'chalk'
import * as inquirer from 'inquirer'
import { repeat } from 'lodash'
import { prettyProject, prettyTime } from '../../util'

export default class Delete extends Command {
  static topic = 'delete'
  static description = 'Delete an existing service'
  static group = 'db'
  static flags: Flags = {
    force: flags.boolean({
      char: 'f',
      description: 'Force delete, without confirmation',
    }),
    ['env-file']: flags.string({
      description: 'Path to .env file to inject env vars',
      char: 'e',
    }),
  }
  async run() {
    const { force } = this.flags

    const envFile = this.flags['env-file']
    await this.definition.load(this.flags, envFile)
    const serviceName = this.definition.service!
    const workspaceName = this.definition.getWorkspace()
    const stage = this.definition.stage!
    const cluster = this.definition.getCluster()
    this.env.setActiveCluster(cluster!)

    await this.client.initClusterClient(
      cluster!,
      serviceName,
      stage,
      this.definition.getWorkspace(),
    )

    const prettyName = `${chalk.bold(serviceName)}@${stage}`

    if (!force) {
      await this.askForConfirmation(prettyName)
    }

    const before = Date.now()
    this.out.action.start(`${chalk.red.bold(`Deleting service ${prettyName} from ${this.definition.cluster}`)}`)
    await this.client.deleteProject(
      serviceName,
      stage,
      this.definition.getWorkspace() || (this.env.activeCluster.workspaceSlug as string),
    )
    this.out.action.stop(prettyTime(Date.now() - before))
  }

  private async askForConfirmation(projects: string) {
    const confirmationQuestion = {
      name: 'confirmation',
      type: 'input',
      message: `Are you sure that you want to delete ${projects}? y/N`,
      default: 'n',
    }
    const { confirmation }: { confirmation: string } = await this.out.prompt(
      confirmationQuestion,
    )
    if (confirmation.toLowerCase().startsWith('n')) {
      this.out.exit(0)
    }
  }
}
