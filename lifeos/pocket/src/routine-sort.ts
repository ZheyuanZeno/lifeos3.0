// Touch scrolling stays native until a stationary long press activates sorting.
export function installRoutineSort(root:HTMLElement,save:(ids:string[])=>Promise<void>,settled:()=>void,enabled=()=>true){
  let gesture:{id:string;pointerId?:number;touchId?:number;x:number;y:number;lastX:number;lastY:number;card:HTMLElement;timer:ReturnType<typeof setTimeout>;dragging:boolean;target?:string;preview?:HTMLElement;offsetX:number;offsetY:number}|undefined
  let frame=0,suppressUntil=0
  const cards=()=>[...root.querySelectorAll<HTMLElement>('[data-routine-id]')]
  const cardAt=(x:number,y:number)=>document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-routine-id]')
  function move(x:number,y:number){
    const g=gesture;if(!g)return;g.lastX=x;g.lastY=y
    if(!g.dragging){if(Math.hypot(x-g.x,y-g.y)>9)cancel();return}
    if(g.preview){g.preview.style.left=x-g.offsetX+'px';g.preview.style.top=y-g.offsetY+'px'}
    const target=cardAt(x,y)
    if(target&&root.contains(target))g.target=target.dataset.routineId
    for(const card of cards())card.classList.toggle('is-drop-target',card.dataset.routineId===g.target&&card!==g.card)
  }
  function scroll(){
    const g=gesture;if(!g?.dragging)return
    const bottom=window.innerHeight-(document.querySelector('.bottom-nav')?.getBoundingClientRect().height??0),speed=g.lastY<85?-10:g.lastY>bottom-65?10:0
    if(speed){window.scrollBy(0,speed);move(g.lastX,g.lastY)}frame=requestAnimationFrame(scroll)
  }
  function start(card:HTMLElement,x:number,y:number,identity:{pointerId?:number;touchId?:number}){
    if(gesture||!enabled())return
    const bounds=card.getBoundingClientRect()
    const timer=setTimeout(()=>{
      const g=gesture;if(!g||!root.contains(card)){cancel();return}
      if(g.pointerId!==undefined)card.setPointerCapture(g.pointerId)
      g.dragging=true;card.classList.add('is-dragging');root.classList.add('is-sorting')
      const preview=card.cloneNode(true) as HTMLElement;preview.removeAttribute('data-routine-id');preview.removeAttribute('id');preview.className='routine-card routine-drag-preview';preview.setAttribute('aria-hidden','true');preview.inert=true;preview.style.width=bounds.width+'px';preview.style.height=bounds.height+'px';document.body.append(preview);g.preview=preview;move(g.lastX,g.lastY);frame=requestAnimationFrame(scroll)
    },450)
    gesture={...identity,id:card.dataset.routineId!,x,y,lastX:x,lastY:y,card,timer,dragging:false,offsetX:x-bounds.left,offsetY:y-bounds.top}
  }
  function clean(){const g=gesture;if(!g)return;clearTimeout(g.timer);cancelAnimationFrame(frame);if(g.pointerId!==undefined&&g.card.hasPointerCapture(g.pointerId))g.card.releasePointerCapture(g.pointerId);g.preview?.remove();root.classList.remove('is-sorting');for(const c of cards())c.classList.remove('is-dragging','is-drop-target');gesture=undefined;return g}
  function cancel(){const g=clean();if(g?.dragging){suppressUntil=performance.now()+700;settled()}}
  async function end(){
    const ids=cards().map(c=>c.dataset.routineId!),g=clean();if(!g?.dragging)return
    suppressUntil=performance.now()+700
    if(g.target&&g.target!==g.id){const from=ids.indexOf(g.id),to=ids.indexOf(g.target);ids.splice(from,1);ids.splice(to,0,g.id);await save(ids)}else settled()
  }
  root.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0||e.target instanceof Element&&e.target.closest('.edit-button'))return;const card=(e.target as Element).closest<HTMLElement>('[data-routine-id]');if(card)start(card,e.clientX,e.clientY,{pointerId:e.pointerId})})
  document.addEventListener('pointermove',e=>{if(gesture?.pointerId!==e.pointerId)return;if(gesture.dragging)e.preventDefault();move(e.clientX,e.clientY)},{passive:false})
  document.addEventListener('pointerup',e=>{if(gesture?.pointerId===e.pointerId)void end()})
  document.addEventListener('pointercancel',e=>{if(gesture?.pointerId===e.pointerId)cancel()})
  root.addEventListener('touchstart',e=>{if(e.touches.length!==1){cancel();return}if((e.target as Element).closest('.edit-button'))return;const card=(e.target as Element).closest<HTMLElement>('[data-routine-id]'),t=e.touches[0];if(card)start(card,t.clientX,t.clientY,{touchId:t.identifier})},{passive:true})
  document.addEventListener('touchmove',e=>{const g=gesture;if(g?.touchId===undefined)return;if(e.touches.length!==1){cancel();return}const t=[...e.touches].find(t=>t.identifier===g.touchId);if(!t)return;if(g.dragging)e.preventDefault();move(t.clientX,t.clientY)},{passive:false})
  document.addEventListener('touchend',e=>{if(gesture?.touchId!==undefined&&[...e.changedTouches].some(t=>t.identifier===gesture?.touchId))void end()})
  document.addEventListener('touchcancel',cancel)
  root.addEventListener('click',e=>{if(performance.now()<suppressUntil&&(e.target as Element).closest('.routine-grid')){e.preventDefault();e.stopImmediatePropagation()}},true)
  root.addEventListener('contextmenu',e=>{if((e.target as Element).closest('[data-routine-id]'))e.preventDefault()})
  root.addEventListener('keydown',e=>{
    if(e.key==='Escape'){cancel();return}
    if(!enabled()||!e.altKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return
    const card=(e.target as Element).closest<HTMLElement>('[data-routine-id]');if(!card)return
    e.preventDefault();const ids=cards().map(c=>c.dataset.routineId!),from=ids.indexOf(card.dataset.routineId!),step=e.key==='ArrowLeft'?-1:e.key==='ArrowRight'?1:e.key==='ArrowUp'?-2:2,to=Math.max(0,Math.min(ids.length-1,from+step));if(to===from)return
    ids.splice(from,1);ids.splice(to,0,card.dataset.routineId!);void save(ids).then(()=>root.querySelector<HTMLButtonElement>('[data-edit-routine="'+card.dataset.routineId+'"]')?.focus())
  })
  window.addEventListener('blur',cancel);window.addEventListener('hashchange',cancel);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel()})
  return {get active(){return !!gesture?.dragging},cancel}
}
