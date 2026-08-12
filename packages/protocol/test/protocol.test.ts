import {describe,it,expect} from 'vitest'; import {clientEventSchema} from '../src/index.js';
describe('protocol',()=>{it('rejects oversized chat',()=>expect(clientEventSchema.safeParse({type:'chat',text:'x'.repeat(501)}).success).toBe(false));it('accepts input',()=>expect(clientEventSchema.safeParse({type:'input',seq:0,direction:'up'}).success).toBe(true));});
