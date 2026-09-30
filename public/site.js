(function () {
  var mobile = window.matchMedia('(max-width: 820px)');
  document.querySelectorAll('.toc-details').forEach(function (details) {
    details.open = !mobile.matches;
  });

  if (navigator.clipboard && window.isSecureContext) {
    document.querySelectorAll('.article-body pre').forEach(function (pre) {
      var wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      pre.parentNode.insertBefore(wrapper, pre);
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-code';
      copy.textContent = '复制代码';
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(pre.textContent).then(function () {
          copy.textContent = '已复制';
          window.setTimeout(function () { copy.textContent = '复制代码'; }, 1800);
        }).catch(function () { copy.textContent = '复制失败'; });
      });
      wrapper.appendChild(copy);
      wrapper.appendChild(pre);
    });
  }

  var form = document.querySelector('.note-tools');
  if (!form) return;
  form.hidden = false;
  var search = document.querySelector('#note-search');
  var category = document.querySelector('#note-category');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.note-row'));
  var count = document.querySelector('#note-count');
  var empty = document.querySelector('#no-results');

  function update() {
    var query = (search.value || '').trim().toLowerCase();
    var selected = category.value || '';
    var visible = 0;
    rows.forEach(function (row) {
      var text = row.textContent.toLowerCase();
      var matches = (!query || text.indexOf(query) !== -1) && (!selected || row.dataset.category === selected);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    count.textContent = '显示 ' + visible + ' / ' + rows.length + ' 篇';
    empty.hidden = visible !== 0;
  }

  search.addEventListener('input', update);
  category.addEventListener('change', update);
  form.addEventListener('submit', function (event) { event.preventDefault(); });
  update();
}());
