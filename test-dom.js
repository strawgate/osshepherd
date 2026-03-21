const cheerio = require('cheerio');

async function testDom() {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://github.com/facebook/react/pull/31998');
  const html = await res.text();
  const $ = cheerio.load(html);
  
  const headerActions = $('.gh-header-actions');
  const tabnavTabs = $('.tabnav-tabs');
  
  console.log('tabnav-tabs count:', tabnavTabs.length);
  if (tabnavTabs.length > 0) {
    console.log('Tabnav first element classes:', tabnavTabs.find('a').first().attr('class'));
  }
  
  // Try to find the title container
  const prTitle = $('h1.gh-header-title');
  console.log('h1.gh-header-title count:', prTitle.length);
  
  // Try to find 'Edit' button
  const editBtn = $('button:contains("Edit"), a:contains("Edit")');
  console.log('Edit buttons found:', editBtn.length);
  
  if (editBtn.length > 0) {
      console.log('Edit button parent classes:', editBtn.first().parent().attr('class'));
  }
}

testDom();
