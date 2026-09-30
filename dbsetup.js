#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const env = { ...process.env }

// The database lives directly on the persistent volume at an absolute path
// (DATABASE_URL=file:/data/dev.sqlite, set in fly.toml) — no symlink
// indirection. An earlier symlink-based approach (pointing a relative
// "file:" path at the volume) proved unreliable: Prisma appears to
// delete-and-recreate the sqlite file rather than write through a dangling
// symlink, silently detaching it from the volume on every deploy.
const target = '/data/dev.sqlite'
const newDb = !fs.existsSync(target)
console.log(`[dbsetup] target=${target} dataDirExists=${fs.existsSync('/data')} newDb=${newDb} BUCKET_NAME=${process.env.BUCKET_NAME ? 'set' : 'unset'}`)
if (newDb && process.env.BUCKET_NAME) {
  console.log('[dbsetup] running litestream restore (newDb=true)')
  await exec(`npx litestream restore -config litestream.yml -if-replica-exists ${target}`)
}

// prepare database
await exec('npx prisma migrate deploy')
await exec(`node -e "const{PrismaClient}=require('@prisma/client');(async()=>{const p=new PrismaClient();const dr=await p.drawerRange.count().catch(()=>-1);const cn=await p.customerNote.count().catch(()=>-1);console.log('[dbsetup] post-migrate counts DrawerRange='+dr+' CustomerNote='+cn);await p.$disconnect();})()"`)

// launch application
if (process.env.BUCKET_NAME) {
  await exec(`npx litestream replicate -config litestream.yml -exec ${JSON.stringify(process.argv.slice(2).join(' '))}`)
} else {
  await exec(process.argv.slice(2).join(' '))
}

function exec(command) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env })
  return new Promise((resolve, reject) => {
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed rc=${code}`))
      }
    })
  })
}
