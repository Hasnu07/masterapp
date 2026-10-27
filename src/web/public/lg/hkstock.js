/*
 * HK Stock: the logistics app's "HK Stock" tab — the same stock engine as
 * London and Dubai (corners "In vault" / "With client", spares `hkSpares`)
 * plus the app's HK situation board (sections in hand / incoming / outgoing /
 * sold, a holder, a stock status, movements with their sales) as a fourth
 * sub-tab, so nothing the app shows for Hong Kong is missing. Drawn by
 * lg/londonstock.js.
 */
'use strict';
LG_PAGES.hkstock = () => lgStockPage('hkstock');
