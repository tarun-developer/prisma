import { Command, flags, Flags } from 'prisma-cli-engine'
import * as fs from 'fs-extra'
import * as ncp from 'copy-paste'

export default class Token extends Command {
  static topic = 'token'
  static description = 'Create a new service token'
  static flags: Flags = {
    copy: flags.boolean({
      char: 'c',
      description: 'Copy token to clipboard',
    }),
    ['env-file']: flags.string({
      description: 'Path to .env file to inject env vars',
      char: 'e',
    }),
  }
  async run() {
    const { copy } = this.flags
    const envFile = this.flags['env-file']
    await this.definition.load(this.flags, envFile)
    const serviceName = this.definition.service!
    const stage = this.definition.stage!
    const cluster = this.definition.getCluster()
    this.env.setActiveCluster(cluster!)

    const token = this.definition.getToken(serviceName, stage)
    if (!token) {
      this.out.log(`There is no secret set in the prisma.yml`)
    } else {
      if (copy) {
        await new Promise(r => {
          ncp.copy(token, () => r())
        })
        this.out.log(`Token copied to clipboard`)
      } else {
        this.out.log(token)
      }
    }
  }
}
