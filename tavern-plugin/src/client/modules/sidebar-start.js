		function TavernStartCards(props) {
			const { newTabOptions, onNewTab } = props;
			const h = React.createElement;
			const groups = [
				['本局', ['dsh-tavern:status', 'dsh-tavern:conversation-settings']],
				['资料库', ['dsh-tavern:cards', 'dsh-tavern:worldbooks', 'dsh-tavern:presets', 'dsh-tavern:resources', 'dsh-tavern:skills', 'dsh-tavern:system-prompts']],
				['偏好', ['dsh-tavern:user-profile', 'dsh-tavern:guide-library', 'dsh-tavern:card-memory']],
				['其他', []]
			];
			const paths = {
				status: 'M4 18a9 9 0 1 1 16 0M12 13l5-5M11 13a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
				'conversation-settings': 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
				cards: 'M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0',
				worldbooks: 'M3 5c0-4 18-4 18 0s-18 4-18 0v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0',
				presets: 'M10 4a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M17 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 6l-3 8M16 6l3 8M9 19h6',
				resources: 'M3 8V5h7l3 3h8v12H3zM3 11h18',
				skills: 'M13 21H5V3h14v9M8 7h8M8 11h5M18 14l1.5 3.5L23 19l-3.5 1.5L18 24l-1.5-3.5L13 19l3.5-1.5z',
				'system-prompts': 'M10 3L6 21M18 3l-4 18M3 9h18M2 15h18',
				'user-profile': 'M3 6h10m4 0h4M3 12h4m4 0h10M3 18h10m4 0h4M13 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M13 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
				'guide-library': 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
				'card-memory': 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
				fallback: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'
			};
			const known = new Set(groups.flatMap(group => group[1]));
			const css = `.dsh-tavern-start{box-sizing:border-box;padding:20px;overflow:auto;min-height:0;width:100%;color:var(--dsw-alias-label-primary);container-type:inline-size}.dsh-tavern-start section+section{margin-top:24px}.dsh-tavern-start h3{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0 0 10px}.dsh-tavern-start-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,112px),1fr));gap:12px}.dsh-tavern-start-card{appearance:none;font:inherit;font-size:14px;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:16px;min-width:0;min-height:112px;padding:16px 8px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;cursor:pointer}.dsh-tavern-start-card:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-secondary)}.dsh-tavern-start-card:focus-visible{outline:2px solid currentColor;outline-offset:2px}.dsh-tavern-start-card:disabled{opacity:.45;cursor:default}.dsh-tavern-start-icon{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:var(--dsw-alias-interactive-bg-hover-accent,#edf1fc);color:var(--dsw-alias-brand-primary,#5279c7)}.dsh-tavern-start-icon svg{width:24px;height:24px}.dsh-tavern-start-label{text-align:center;line-height:1.45;overflow-wrap:anywhere}@container(max-width:260px){.dsh-tavern-start-grid{gap:8px}.dsh-tavern-start-card{font-size:13px;padding:12px 6px;min-height:100px}}`;
			return h('div', {className:'dsh-tavern-start'}, h('style',null,css), groups.map(([title, ids]) => {
				const options = ids.length ? ids.map(id => newTabOptions.find(option => option.id === id)).filter(Boolean) : newTabOptions.filter(option => !known.has(option.id));
				if (!options.length) return null;
				return h('section',{key:title,'aria-label':title},h('h3',null,title),h('div',{className:'dsh-tavern-start-grid'},options.map(option => {
					const key=option.id.replace('dsh-tavern:','');
					const icon=paths[key] ? h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round'},h('path',{d:paths[key]})) : option.icon ?? h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8},h('path',{d:paths.fallback}));
					return h('button',{key:option.id,type:'button',className:'dsh-tavern-start-card',disabled:option.disabled===true,title:option.label,onClick:()=>onNewTab(option.id)},h('span',{className:'dsh-tavern-start-icon','aria-hidden':true},icon),h('span',{className:'dsh-tavern-start-label'},option.label));
				})));
			}));
		}

function registerTavernStartPage(ctx, slots) {
 ctx.inject(["sidebarRightTabs"], injected => {
  const registry = injected.get("sidebarRightTabs");
  injected.effect(() => slots.inject("sidebar.right.tab.guide", () => slots.register({name:"sidebar.right.tab.guide",id:"dsh-tavern:start",priority:-1,select:()=>true}, function TavernStartPage(props) {
   const entries = React.useSyncExternalStore(callback => registry.subscribe(callback), () => registry.guide());
   const {tab} = props.useTabInfo();
   return React.createElement(TavernStartCards,{newTabOptions:entries.map(entry => ({id:entry.kind,label:entry.title(),icon:entry.icon ? React.createElement(entry.icon,{size:24}) : null})),onNewTab:id=>tab.actions.openTab(id,{replaceTab:true})});
  })), "dsh-tavern: native start page");
 });
}
