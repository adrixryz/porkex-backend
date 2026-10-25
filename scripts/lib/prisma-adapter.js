const { PrismaLibSql } = require('@prisma/adapter-libsql')

function preserveUtcDates(adapter) {
  for (const method of ['queryRaw', 'executeRaw']) {
    const run = adapter[method].bind(adapter)
    adapter[method] = query => {
      const args = query.args.map((value, index) =>
        value !== null && query.argTypes[index]?.scalarType === 'datetime'
          ? new Date(value).toISOString().replace('.000Z', '+00:00').replace('Z', '+00:00')
          : value
      )
      const argTypes = query.argTypes.map(type =>
        type.scalarType === 'datetime' ? { ...type, scalarType: 'string' } : type
      )
      return run({ ...query, args, argTypes })
    }
  }
  if (adapter.startTransaction) {
    const start = adapter.startTransaction.bind(adapter)
    adapter.startTransaction = async (...args) => preserveUtcDates(await start(...args))
  }
  return adapter
}

// Keep the established UTC TEXT representation so indexed filters also find old rows.
function createPrismaAdapter(client) {
  class SharedClientAdapter extends PrismaLibSql {
    createClient() {
      return client
    }
    async connect() {
      return preserveUtcDates(await super.connect())
    }
  }
  return new SharedClientAdapter({ url: 'file::memory:' })
}

module.exports = { createPrismaAdapter }
