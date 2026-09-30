#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const env = { ...process.env }

// place Sqlite3 database on volume.
// Prisma resolves a relative sqlite "file:" URL against the directory that
// contains schema.prisma (prisma/), not the process's cwd or filesystem
// root — so the real database file lives at prisma/dev.sqlite, not
// /dev.sqlite. Symlinking the wrong path meant this never actually pointed
// at the persistent volume, so every deploy silently started from a fresh,
// empty database.
const source = path.resolve('prisma/dev.sqlite')
const target = '/data/' + path.basename(source)
console.log(`[dbsetup] source=${source} target=${target} dataDirExists=${fs.existsSync('/data')} sourceExistsBefore=${fs.existsSync(source)} targetExistsBefore=${fs.existsSync(target)}`)
if (!fs.existsSync(source) && fs.existsSync('/data')) fs.symlinkSync(target, source)
const newDb = !fs.existsSync(target)
console.log(`[dbsetup] newDb=${newDb} BUCKET_NAME=${process.env.BUCKET_NAME ? 'set' : 'unset'}`)
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
