import {readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
const allowed={domain:[],contracts:[],application:['domain','contracts'],storage:['domain','contracts','application'],connectors:['contracts'], 'plugin-host':['contracts'],model:['contracts'],evals:['contracts','domain','application']}
async function walk(dir){const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat()}
const errors=[]
for(const [name,dependencies] of Object.entries(allowed))for(const file of await walk(`packages/${name}/src`)){
 const text=await readFile(file,'utf8')
 for(const match of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)/g)){
  const dep=match[1]
  if(dep.startsWith('@memo/')&&!dependencies.includes(dep.slice(6)))errors.push(`${file}: forbidden dependency ${dep}`)
  if(dep.startsWith('../') && dep.includes('/src'))errors.push(`${file}: cross-package relative import ${dep}`)
  if(name==='domain'&&!dep.startsWith('.'))errors.push(`${file}: domain must be platform independent (${dep})`)
 }
}
if(errors.length){console.error(errors.join('\n'));process.exit(1)}
console.log('Package boundaries passed')
