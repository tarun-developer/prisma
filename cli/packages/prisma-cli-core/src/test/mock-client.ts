import { makeExecutableSchema, addMockFunctionsToSchema } from 'graphql-tools'
import { graphql, ExecutionResult } from 'graphql'
import * as fs from 'fs-extra'

const typeDefs = fs.readFileSync(__dirname + '/cluster.graphql', 'utf-8')

const schema = makeExecutableSchema({ typeDefs })

addMockFunctionsToSchema({
  schema,
  mocks: {
    Migration: () => ({
      revision: 5,
    }),
  },
})

export const MockGraphQLClient = () => {
  return {
    request(query, variables) {
      return graphql(schema, query, {}, {}, variables) as any
    },
  }
}

export { ExecutionResult }
