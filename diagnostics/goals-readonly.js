/* Paste into the app's developer console on each device. Only GET requests;
   no sync(), saves, deletes, migrations or token output. */
(async () => {
    const client = window.CloudSync?.client;
    if (!client) throw new Error('Supabase client is not initialized');
    const report = { time: new Date().toISOString(), connection: window.CloudSync.connectionState(), local: {} };
    const userResult = await client.auth.getUser();
    const user = userResult.data?.user;
    report.auth = { id: user?.id ?? null, email: user?.email ?? null,
        error: userResult.error ? { status: userResult.error.status, name: userResult.error.name, message: userResult.error.message } : null };
    const local = window.app?.goals || [];
    const cachedUser = window.app?.user;
    report.local = { profileId: cachedUser?.id, supabaseUserId: cachedUser?.supabaseUserId,
        count: local.length, ids: local.map(goal => goal.id) };
    const root = String(client.rest?.url || '').replace(/\/$/, '');
    if (!root || typeof client.rest?.fetch !== 'function') throw new Error('Authenticated REST transport unavailable');
    async function get(path, accept = 'application/json') {
        try {
            const response = await client.rest.fetch(root + path, { method:'GET', headers:{ Accept:accept }, cache:'no-store' });
            const body = await response.text();
            return { status:response.status, statusText:response.statusText, body };
        } catch (error) { return { status:null, error:String(error) }; }
    }
    const schema = await get('/', 'application/openapi+json');
    report.schema = schema;
    if (schema.status === 200) {
        try {
            const parsed = JSON.parse(schema.body);
            report.schema = { status:200, goals:parsed.definitions?.goals || parsed.components?.schemas?.goals || null };
        } catch {}
    }
    report.pull = [];
    if (user?.id) {
        for (let offset = 0; ; offset += 500) {
            const page = await get('/goals?select=*&user_id=eq.' + encodeURIComponent(user.id) + '&order=id&limit=500&offset=' + offset);
            // Keep full error bodies. Successful rows contain private goal content;
            // show only IDs and owner IDs in the shareable diagnostic report.
            if (page.status !== 200 && page.status !== 206) { report.pull.push(page); break; }
            let rows;
            try { rows = JSON.parse(page.body); } catch { report.pull.push(page); break; }
            if (!Array.isArray(rows)) { report.pull.push(page); break; }
            report.pull.push({ status:page.status, count:rows.length, rows:rows.map(row => ({id:row.id,user_id:row.user_id})) });
            if (rows.length < 500) break;
        }
    }
    report.push = { executed:false, reason:'Read-only diagnostics; no cloud writes',
        payloadFields:['user_id','id','title','description','priority','category','status','progress','subgoals','tags','parent_id'],
        goalIdTypes:local.map(goal => ({id:goal.id, uuid:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(goal.id)})) };
    console.log(JSON.stringify(report, null, 2));
    return report;
})();
