'use strict';
/* ================= 灯箱 ================= */
var lb = { list: [], idx: 0 };
function openLb(p, idx) {
  lb.list = p.images.map(function (nm) { return mediaUrl(p.dir, nm); });
  lb.idx = idx || 0;
  $('#lightbox').hidden = false;
  renderLb();
}
function renderLb() {
  var im = $('#lb-img');
  im.removeAttribute('src');
  var n = lb.list.length;
  $('#lb-counter').textContent = n ? (lb.idx + 1) + ' / ' + n : '';
  $('#lb-prev').disabled = lb.idx <= 0;
  $('#lb-next').disabled = lb.idx >= n - 1;
  var dl = $('#lb-dl');
  dl.href = lb.list[lb.idx];
  var mediaPath = decodeURIComponent(lb.list[lb.idx].replace(/^\/media\//, ''));
  dl.setAttribute('download', mediaPath.split('/').pop() || 'image');
  im.src = lb.list[lb.idx];
  im.style.animation = 'none';
  void im.offsetWidth;   /* 切图重播淡入 */
  im.style.animation = '';
}
function lbMove(d) {
  var n = lb.list.length;
  var next = lb.idx + d;
  if (next < 0 || next >= n) return;
  lb.idx = next;
  renderLb();
}
function closeLb() {
  lbMenuHide();
  $('#lightbox').hidden = true;
}

/* ================= 灯箱右键菜单：复制图片 / 保存图片 ================= */
function lbMenuHide() { $('#lb-menu').hidden = true; }
$('#lightbox').addEventListener('contextmenu', function (ev) {
  ev.preventDefault();
  var menu = $('#lb-menu');
  menu.hidden = false;
  /* 右下角越界收拢 */
  menu.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8)) + 'px';
});
/* 复制图片：经 canvas 转成 PNG 写入剪贴板（contextmenu 属用户手势，clipboard.write 放行） */
$('#lb-copy').onclick = function () {
  var url = lb.list[lb.idx];
  lbMenuHide();
  if (!url) return;
  var im = new Image();
  im.onload = function () {
    var cv = document.createElement('canvas');
    cv.width = im.naturalWidth;
    cv.height = im.naturalHeight;
    cv.getContext('2d').drawImage(im, 0, 0);
    cv.toBlob(function (blob) {
      if (!blob || !navigator.clipboard || !window.ClipboardItem) { toast('当前环境不支持复制图片', 'err'); return; }
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
        toast('图片已复制到剪贴板', 'ok');
      }, function () { toast('复制失败：浏览器拒绝了剪贴板写入', 'err'); });
    }, 'image/png');
  };
  im.onerror = function () { toast('图片加载失败', 'err'); };
  im.src = url;
};
/* 保存图片：复用当前图的下载语义（a[download] + 服务端直出） */
$('#lb-save').onclick = function () {
  var url = lb.list[lb.idx];
  lbMenuHide();
  if (!url) return;
  var a = document.createElement('a');
  a.href = url;
  var mediaPath = decodeURIComponent(url.replace(/^\/media\//, ''));
  a.download = mediaPath.split('/').pop() || 'image';
  document.body.appendChild(a);
  a.click();
  a.remove();
};
