// SPDX-License-Identifier: Apache-2.0
// v1.2: integrated round 2 inputs, shared with the frozen 201363f replies.
const tail = '<h3>More discussion</h3><p>Later visitor evidence.</p>';
const thread = (heading: string) => '<h2>Comments</h2><p>First visitor evidence.</p>' + heading + tail;
const opening = (heading: string) => heading + '<p role="comment">First visitor evidence.</p><h3>More discussion</h3><p>Later visitor evidence.</p>';
export const HEADING_CASES = [
  ...['role="comment"', 'class="comment"', 'itemprop="reviewBody"', 'typeof="schema:Review"'].map((attr, i) => ({ id: `marked-descendant-${i}`, html: thread(`<h2><span ${attr}>Visitor heading</span></h2>`), visitor: true, changed: true })),
  { id: 'empty', html: thread('<h2></h2>'), visitor: true, changed: true },
  { id: 'whitespace-only', html: thread('<h2> \n\t </h2>'), visitor: true, changed: true },
  { id: 'hidden-only', html: thread('<h2><span hidden>Contact</span></h2>'), visitor: true, changed: true },
  { id: 'split-word', html: opening('<h2>Com<span>ments</span></h2>'), visitor: true, changed: true },
  { id: 'trailing-padding', html: opening('<h2>Comments' + ' '.repeat(300) + '</h2>'), visitor: true, changed: true },
  { id: 'leading-padding', html: opening('<h2>' + ' '.repeat(300) + 'Comments</h2>'), visitor: true, changed: true },
  { id: 'split-whitespace', html: opening('<h2>Customer <span> \n comments</span></h2>'), visitor: true, changed: false },
  { id: 'hidden-suffix', html: opening('<h2>Comments<span hidden> policy</span></h2>'), visitor: true, changed: false },
  { id: 'inert-suffix', html: opening('<h2>Comments<template> policy</template><script> policy</script></h2>'), visitor: true, changed: false },
  { id: 'visible-suffix', html: opening('<h2>Comments<span> policy</span></h2>'), visitor: false, changed: false },
  { id: 'normalised-200', html: opening('<h2>2 comments to ' + 'x'.repeat(186) + ' '.repeat(300) + '</h2>'), visitor: true, changed: true },
  { id: 'normalised-201', html: opening('<h2>2 comments to ' + 'x'.repeat(187) + '</h2>'), visitor: false, changed: false },
  { id: 'marked-opening', html: opening('<h2><span role="comment">Comments</span></h2>'), visitor: false, changed: true },
  { id: 'marked-heading', html: opening('<h2 role="comment">Comments</h2>'), visitor: false, changed: false },
  { id: 'hidden-mark', html: thread('<h2>Contact<span role="comment" hidden>Visitor heading</span></h2>'), visitor: false, changed: false },
  { id: 'empty-mark', html: thread('<h2>Contact<span role="comment"></span></h2>'), visitor: false, changed: false },
  { id: 'inert-mark', html: thread('<h2>Contact<template><span role="comment">Visitor heading</span></template></h2>'), visitor: false, changed: false },
  { id: 'own-mark-closure', html: thread('<h2 role="comment">Contact</h2>'), visitor: true, changed: false },
  ...[1, 2, 3, 6].map(rank => ({ id: `nested-rank-${rank}`, html: thread(`<div><h${rank}>Contact</h${rank}><p>Nested evidence.</p></div>`), visitor: true, changed: false })),
  { id: 'sibling-close', html: thread('<h2>Contact</h2>'), visitor: false, changed: false },
  { id: 'container-close', html: '<section><h2>Comments</h2><p>First visitor evidence.</p></section>' + tail, visitor: false, changed: false },
  { id: 'quieted-heading', html: '<section><h2>Comments</h2><div><p role="comment">First visitor evidence.</p><p>' + 'Later visitor evidence about bakery opening times. '.repeat(13) + '</p></div></section>', visitor: true, changed: false },
  { id: 'quieted-unmarked', html: '<section><h2>Comments</h2><div><p>' + 'Later visitor evidence about bakery opening times. '.repeat(13) + '</p></div></section>', visitor: true, changed: false },
  { id: 'flattened-region', html: '<div>'.repeat(253) + '<section><h2>Com<span>ments</span></h2>' + '<div>'.repeat(300) + '<p role="comment">First visitor evidence.</p><h3>More discussion</h3><p>Later visitor evidence.</p>' + '</div>'.repeat(300) + '</section><h2>Contact</h2><p>Site outside evidence.</p>' + '</div>'.repeat(253), visitor: true, changed: true },
  { id: 'flattened-end', html: '<div>'.repeat(255) + '<section><h2>Comments</h2><p>First visitor evidence.</p>' + '<div>'.repeat(300) + 'Nested evidence.' + '</div>'.repeat(300) + '</section><p>Later visitor evidence.</p>' + '</div>'.repeat(255), visitor: false, changed: false },
];
