import {describe,it,expect} from 'vitest'; import {addPlayer,canStartMatch,initialState,move,removePlayer,roster,sampleTagGame,setReady,setSpectator,tick,view} from '../src/index.js';
describe('tag rules',()=>{it('moves only in running phase',()=>{let s=addPlayer(initialState(),'a','A',false);s.phase='running';expect(move(s,'a','right',1).players.a.x).toBeGreaterThan(s.players.a.x)});it('completes timer',()=>{let s=initialState();s.phase='running';s.remainingMs=1;expect(tick(s,1).phase).toBe('completed')});});
describe('ready rules',()=>{
  it('toggles readiness for participants but not spectators',()=>{
    let s=addPlayer(addPlayer(initialState(),'a','A',false),'b','B',true);
    s=setReady(s,'a',true);
    expect(s.players.a.ready).toBe(true);
    s=setReady(s,'b',true);
    expect(s.players.b.ready).toBe(false);
    s.phase='running';
    s=setReady(s,'a',false);
    expect(s.players.a.ready).toBe(true);
  });
  it('gates match start on minimum players and full readiness',()=>{
    let s=addPlayer(initialState(),'a','A',false);
    expect(canStartMatch(s)).toBe(false);
    s=addPlayer(s,'b','B',true);
    s=setReady(s,'a',true);
    expect(canStartMatch(s)).toBe(false);
    s=addPlayer(s,'c','C',false);
    expect(canStartMatch(s)).toBe(false);
    s=setReady(s,'c',true);
    expect(canStartMatch(s)).toBe(true);
  });
  it('reassigns IT when the IT holder becomes a spectator mid-match',()=>{
    let s=addPlayer(addPlayer(initialState(),'a','A',false),'b','B',false);
    s.phase='running';
    s=tick(s,0.001);
    expect(s.itPlayerId).toBe('a');
    s=setSpectator(s,'a',true);
    expect(s.players.a.spectator).toBe(true);
    expect(s.itPlayerId).toBe('b');
    // A spectator cannot take or hold the IT role on later ticks either.
    s=tick(s,0.001);
    expect(s.itPlayerId).toBe('b');
  });
});
describe('tag definition',()=>{
  it('removes a player and releases the IT role',()=>{
    let s=addPlayer(addPlayer(initialState(),'a','A',false),'b','B',false);
    s.phase='running';
    s=tick(s,0.001);
    expect(s.itPlayerId).toBe('a');
    s=removePlayer(s,'a');
    expect(s.players.a).toBeUndefined();
    expect(s.itPlayerId).toBeNull();
  });
  it('maps generic roster rows and game-specific views',()=>{
    const s=addPlayer(initialState(),'a','A',false);
    expect(roster(s)).toEqual([{id:'a',name:'A',score:0,spectator:false,ready:false}]);
    expect(view(s).players).toEqual([{id:'a',x:s.players.a.x,y:s.players.a.y,color:s.players.a.color}]);
    expect(view(s).itPlayerId).toBeNull();
  });
  it('rejects input payloads that are not tag inputs',()=>{
    expect(sampleTagGame.inputSchema.safeParse({type:'input',seq:0,direction:'up'}).success).toBe(true);
    expect(sampleTagGame.inputSchema.safeParse({type:'input',seq:0,op:'dash'}).success).toBe(false);
  });
  it('ignores input and keeps scores at zero outside the running phase',()=>{
    let s=addPlayer(addPlayer(initialState(),'a','A',false),'b','B',false);
    const x=s.players.a.x;
    s=sampleTagGame.applyInput(s,'a',{type:'input',seq:1,direction:'right'},1);
    expect(s.players.a.x).toBe(x);
    expect(sampleTagGame.getResults(s).map(r=>r.score)).toEqual([0,0]);
  });
});
