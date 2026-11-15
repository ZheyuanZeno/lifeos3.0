import {describe,it,expect} from 'vitest'
import {toCommand,toolSchemas} from '../workers/mcp/src/contracts'
const data={title:'Meeting',date:'2026-11-18',source_id:'image:stable:1'}
describe('native MCP strict contracts',()=>{
 it('deduplicates identical stable sources in a batch',()=>expect(toCommand('lifeos_create_plans',{command_id:'batch',items:[data,data]}).operations).toHaveLength(1))
 it('rejects ambiguous repeated items without a source',()=>expect(()=>toCommand('lifeos_create_plans',{command_id:'batch',items:[{title:'a',date:data.date},{title:'a',date:data.date}]})).toThrow())
 it('rejects unsupported reminders, bad dates and arbitrary image/script fields',()=>{
  expect(()=>toCommand('lifeos_create_plan',{command_id:'a',data:{...data,reminder_minutes_before:30}})).toThrow('提前')
  expect(()=>toCommand('lifeos_create_plan',{command_id:'a',data:{...data,date:'2026-02-30'}})).toThrow()
  expect(()=>toolSchemas.lifeos_create_plan.parse({command_id:'a',data:{...data,image:'bytes',javascript:'alert(1)'}})).toThrow()
 })
 it('requires a version for modifications',()=>expect(()=>toolSchemas.lifeos_update_plan.parse({command_id:'a',id:'target',data:{title:'changed'}})).toThrow())
})
