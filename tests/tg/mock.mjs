// in-memory stand-in for supabase-js: tables + auth admin
export const T = { tg_logins: [], tg_links: [], profiles: [] };
export const users = [];   // {id,email,anon}
export const log = [];
export const RPC = {};   // fake database functions: name → (args) => ({ data, error })
export const fail = { create: false, link: false };
let n = 0;
class Q {
  constructor(t){ this.t = t; this.f = []; this.op = 'select'; }
  select(){ if (this.op === 'select') this.op = 'select'; else this.ret = true; return this; }
  eq(k, v){ this.f.push(r => r[k] === v); return this; }
  lt(k, v){ this.f.push(r => r[k] < v); return this; }
  delete(){ this.op = 'delete'; return this; }
  update(o){ this.op = 'update'; this.o = o; return this; }
  insert(o){ this.op = 'insert'; this.o = o; return this; }
  upsert(o, opt = {}){ this.op = 'upsert'; this.o = o; this.opt = opt; return this; }
  maybeSingle(){ this.one = true; return this; }
  run(){
    const rows = T[this.t], m = r => this.f.every(f => f(r));
    const key = this.t === 'tg_logins' ? 'nonce' : this.t === 'tg_links' ? 'tg_id' : 'id';
    let data = null;
    if (this.op === 'select') data = rows.filter(m);
    else if (this.op === 'delete'){ data = rows.filter(m); T[this.t] = rows.filter(r => !m(r)); }
    else if (this.op === 'update'){ rows.filter(m).forEach(r => Object.assign(r, this.o)); }
    else if (this.op === 'upsert'){
      const ex = rows.find(r => r[key] === this.o[key]);
      if (this.t === 'tg_links' && rows.find(r => r.user_id === this.o.user_id && r.tg_id !== this.o.tg_id)) return { data: null, error: { message: 'unique user_id' } };
      if (ex){ if (!this.opt.ignoreDuplicates) Object.assign(ex, this.o); data = this.opt.ignoreDuplicates ? [] : [ex]; }
      else { const r = { created_at: new Date().toISOString(), ...this.o }; rows.push(r); data = [r]; }
    }
    if (this.one) data = data?.[0] ?? null;
    return { data, error: null };
  }
  then(a, b){ return Promise.resolve(this.run()).then(a, b); }
}
export function createClient(){
  return {
    from: t => new Q(t),
    rpc: async (fn, args) => { log.push(['rpc', fn, args]); return RPC[fn] ? RPC[fn](args) : { data: null, error: null }; },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    auth: {
      getUser: async tok => ({ data: { user: users.find(u => u.id === tok.split('.')[1]) ?? null } }),
      verifyOtp: async ({ token_hash }) => ({ data: { session: { access_token: 'acc.' + token_hash, refresh_token: 'r', expires_at: 1, expires_in: 1 } }, error: null }),
      admin: {
        updateUserById: async (id, { email }) => {
          if (users.some(u => u.email === email && u.id !== id)) return { error: { code: 'email_exists', status: 422 } };
          users.find(u => u.id === id).email = email; return { error: null };
        },
        createUser: async ({ email }) => {
          if (fail.create){ fail.create = false; throw new Error('boom'); }
          if (users.some(u => u.email === email)) return { data: { user: null }, error: { code: 'email_exists', status: 422 } };
          const u = { id: 'u' + (++n), email }; users.push(u); return { data: { user: u }, error: null };
        },
        generateLink: async ({ email }) => { if (fail.link){ fail.link = false; return { data: null, error: { message: 'temp' } }; } const u = users.find(x => x.email === email); log.push(['gl', email]); return u ? { data: { user: u, properties: { hashed_token: u.id } }, error: null } : { data: null, error: { message: 'nf' } }; },
      },
    },
  };
}
