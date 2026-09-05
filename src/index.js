const STATES = Object.freeze({
  NEW: "NEW",
  WAITING_ADDRESS: "WAITING_ADDRESS",
  WAITING_ADDRESS_CONFIRM: "WAITING_ADDRESS_CONFIRM",
  WAITING_PHONE_CONFIRM: "WAITING_PHONE_CONFIRM",
  WAITING_PHONE_INPUT: "WAITING_PHONE_INPUT",
  WAITING_ORDER_CONFIRM: "WAITING_ORDER_CONFIRM",
  HUMAN_TAKEOVER: "HUMAN_TAKEOVER",
  COMPLETED: "COMPLETED"
});

const ACTIONS = Object.freeze({
  HUMAN: "HUMAN",
  FOOD_DETAILS: "FOOD_DETAILS",
  MODIFY_ORDER: "MODIFY_ORDER",
  ADDRESS_CORRECT: "ADDRESS_CORRECT",
  ADDRESS_WRONG: "ADDRESS_WRONG",
  USE_ACCOUNT_PHONE: "USE_ACCOUNT_PHONE",
  ADD_PHONE: "ADD_PHONE",
  CONFIRM_ORDER: "CONFIRM_ORDER"
});

const MSG = {
  welcome: (url) =>
    `您好，欢迎来到闽南小吃！\n\n` +
    `如需下单，请点击以下网址选择您需要的食品并加入购物车：\n` +
    `${url}\n\n` +
    `选择完成后，请点击 WhatsApp 下单，我们会继续为您确认配送信息。`,

  askAddress:
    `您好，已收到您的订单。\n\n` +
    `请直接发送您的配送地址文字信息。\n\n` +
    `建议提供：门牌号、小区/公寓名称、区域。`,

  addressNotFound:
    `抱歉，我们暂时无法识别这个地址。\n\n` +
    `请重新发送完整配送地址。\n` +
    `建议提供：门牌号、小区/公寓名称、区域。`,

  addressWrong:
    `好的，请重新发送您的配送地址。\n\n` +
    `建议位置信息包含：门牌号、小区/公寓名称、区域。`,

  addressConfirm: (address) =>
    `已找到以下配送位置：\n\n` +
    `📍 ${address}\n\n` +
    `请确认配送位置是否正确。`,

  phonePrompt: (phone) =>
    `接下来请确认联系手机号码。\n\n` +
    `联系号码：${phone}\n\n` +
    `注意：必须使用马来西亚号码。\n\n` +
    `请确认是否使用此号码作为联系号码。`,

  phoneRejected:
    `抱歉，此号码格式不正确。\n\n` +
    `请添加以 +60 开头的马来西亚手机号码。\n` +
    `例如：+60123456789`,

  askPhone:
    `好的，请直接发送您的联系手机号码。\n\n` +
    `必须使用以 +60 开头的马来西亚号码。\n` +
    `例如：+60123456789`,

  orderConfirm: ({ itemsText, totalText, address, phone }) =>
    `请确认您的订单：\n\n` +
    `${itemsText}\n\n` +
    `总计：${totalText}\n\n` +
    `配送地址：\n${address}\n\n` +
    `联系号码：\n${phone}\n\n` +
    `请确认以上信息是否正确。`,

  orderDone:
    `好的，您的订单已经确认。\n\n` +
    `我们已经收到您的订单，并会根据您提供的信息进行安排。\n` +
    `谢谢您的支持！`,

  human:
    `好的，已通知人工客服，请稍候。`
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function isTestMode(env) {
  return String(env.TEST_MODE || "false").toLowerCase() === "true";
}

/* -------------------------
   Phone helpers
-------------------------- */

function normalizePhone(phone) {
  if (!phone) return "";

  const cleaned = String(phone)
    .trim()
    .replace(/[^\d+]/g, "");

  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function isValidMYPlus60(phone) {
  const value = String(phone || "")
    .replace(/[\s()-]/g, "");

  return /^\+60\d{8,10}$/.test(value);
}

function formatPhone(phone) {
  const normalized = normalizePhone(phone);

  if (!/^\+60\d{8,10}$/.test(normalized)) {
    return normalized;
  }

  const local = normalized.slice(3);

  if (local.length === 9) {
    return `+60 ${local.slice(0, 2)}-${local.slice(2, 5)} ${local.slice(5)}`;
  }

  if (local.length === 10) {
    return `+60 ${local.slice(0, 2)}-${local.slice(2, 6)} ${local.slice(6)}`;
  }

  return normalized;
}

/* -------------------------
   Order parsing
-------------------------- */

function isOrderText(text) {
  const value = String(text || "");

  const hasOrderMarker =
    value.includes("订单明细") ||
    value.toLowerCase().includes("order details");

  const hasTotal =
    /总计\s*[:：]\s*rm\s*\d+(?:\.\d{1,2})?/i.test(value) ||
    /total\s*[:：]?\s*rm\s*\d+(?:\.\d{1,2})?/i.test(value);

  const hasItemLine =
    /(^|\n)\s*[•\-*]\s*.+?\s*x\s*\d+\s*$/im.test(value);

  return hasOrderMarker && (hasTotal || hasItemLine);
}

function parseOrder(text) {
  const raw = String(text || "").trim();

  const lines = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    const match = line.match(
      /^[•\-*]\s*(.+?)\s*x\s*(\d+)\s*$/i
    );

    if (match) {
      items.push({
        name: match[1].trim(),
        quantity: Number(match[2])
      });
    }
  }

  const totalMatch = raw.match(
    /(?:总计|total)\s*[:：]?\s*rm\s*(\d+(?:\.\d{1,2})?)/i
  );

  return {
    raw,
    items,
    subtotal: totalMatch ? Number(totalMatch[1]) : null
  };
}

function itemsToText(items) {
  if (!items?.length) {
    return "• 订单商品读取异常，请转人工";
  }

  return items
    .map((item) => `• ${item.name} × ${item.quantity}`)
    .join("\n");
}

function moneyText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "RM 0.00";
  }

  return `RM ${value.toFixed(2)}`;
}

/* -------------------------
   Database
-------------------------- */

async function getCustomer(env, whatsappId) {
  return env.DB.prepare(
    "SELECT * FROM customers WHERE whatsapp_id = ?1"
  )
    .bind(whatsappId)
    .first();
}

async function ensureCustomer(env, whatsappId, displayName = null) {
  await env.DB.prepare(`
    INSERT INTO customers (whatsapp_id, display_name)
    VALUES (?1, ?2)
    ON CONFLICT(whatsapp_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, customers.display_name),
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(whatsappId, displayName)
    .run();

  return getCustomer(env, whatsappId);
}

async function updateCustomer(env, whatsappId, fields) {
  const allowed = [
    "state",
    "human_takeover",
    "human_reason",
    "contact_phone",
    "address_text",
    "address_formatted",
    "latitude",
    "longitude"
  ];

  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${key} = ?${values.length}`);
    }
  }

  if (!sets.length) return;

  values.push(whatsappId);

  await env.DB.prepare(`
    UPDATE customers
    SET ${sets.join(", ")},
        updated_at = CURRENT_TIMESTAMP
    WHERE whatsapp_id = ?${values.length}
  `)
    .bind(...values)
    .run();
}

async function getOpenOrder(env, customerId) {
  return env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE customer_id = ?1
      AND status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1
  `)
    .bind(customerId)
    .first();
}

async function createOrder(env, customerId, parsed) {
  const result = await env.DB.prepare(`
    INSERT INTO orders (
      customer_id,
      status,
      items_json,
      raw_text,
      subtotal
    )
    VALUES (?1, 'OPEN', ?2, ?3, ?4)
  `)
    .bind(
      customerId,
      JSON.stringify(parsed.items),
      parsed.raw,
      parsed.subtotal
    )
    .run();

  return result.meta?.last_row_id;
}

async function updateOpenOrder(env, customerId, fields) {
  const order = await getOpenOrder(env, customerId);

  if (!order) return null;

  const allowed = [
    "address_text",
    "address_formatted",
    "latitude",
    "longitude",
    "contact_phone",
    "status"
  ];

  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${key} = ?${values.length}`);
    }
  }

  if (!sets.length) {
    return order;
  }

  values.push(order.id);

  await env.DB.prepare(`
    UPDATE orders
    SET ${sets.join(", ")},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?${values.length}
  `)
    .bind(...values)
    .run();

  return env.DB.prepare(
    "SELECT * FROM orders WHERE id = ?1"
  )
    .bind(order.id)
    .first();
}

/* -------------------------
   WhatsApp API
-------------------------- */

function graphUrl(env) {
  const version = env.WHATSAPP_GRAPH_VERSION || "v23.0";

  return (
    `https://graph.facebook.com/${version}` +
    `/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  );
}

async function whatsappRequest(env, payload) {
  if (
    !env.WHATSAPP_TOKEN ||
    !env.WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID"
    );
  }

  const response = await fetch(graphUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `WhatsApp API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

/*
  We use a List Message instead of trying to put 5 actions
  into normal reply buttons.

  This lets the customer always access:
  - 转人工
  - 询问食物详情
  - 修改订单

  plus whatever action is needed for the current step.
*/

async function sendMenu(env, to, body, rows) {
  const safeRows = rows.slice(0, 10);

  if (isTestMode(env)) {
    return {
      test: true,
      type: "menu",
      to,
      body,
      rows: safeRows
    };
  }

  return whatsappRequest(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: body
      },
      action: {
        button: "请选择",
        sections: [
          {
            title: "操作",
            rows: safeRows.map((row) => ({
              id: row.id,
              title: row.title,
              description: row.description || ""
            }))
          }
        ]
      }
    }
  });
}

async function sendLocation(env, to, location) {
  if (isTestMode(env)) {
    return {
      test: true,
      type: "location",
      to,
      latitude: location.latitude,
      longitude: location.longitude,
      name: location.name || "配送位置",
      address: location.address || ""
    };
  }

  return whatsappRequest(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "location",
    location: {
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      name: location.name || "配送位置",
      address: location.address || ""
    }
  });
}

/* -------------------------
   Google Geocoding
-------------------------- */

async function geocodeAddress(env, addressText) {
  if (!env.GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY");
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(addressText)}` +
    "&region=my" +
    "&language=en" +
    `&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Geocoding HTTP ${response.status}`);
  }

  const data = await response.json();

  if (
    data.status !== "OK" ||
    !data.results ||
    !data.results.length
  ) {
    return null;
  }

  const result = data.results[0];
  const location = result.geometry?.location;

  if (!location) {
    return null;
  }

  const component = result.address_components?.find(
    (item) =>
      item.types?.includes("premise") ||
      item.types?.includes("establishment") ||
      item.types?.includes("point_of_interest")
  );

  return {
    formattedAddress: result.formatted_address,
    latitude: location.lat,
    longitude: location.lng,
    name: component?.long_name || "配送位置"
  };
}

/* -------------------------
   Human takeover
-------------------------- */

async function notifyHuman(env, customer, reason) {
  if (
    !env.HUMAN_NOTIFICATION_TO ||
    isTestMode(env)
  ) {
    return;
  }

  try {
    await whatsappRequest(env, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(env.HUMAN_NOTIFICATION_TO),
      type: "text",
      text: {
        body:
          `🔴 需要人工处理\n\n` +
          `客户：${normalizePhone(customer.whatsapp_id)}\n` +
          `原因：${reason}\n` +
          `机器人已停止自动回复。`
      }
    });
  } catch (error) {
    console.error(
      "Human notification failed:",
      error
    );
  }
}

async function takeOverHuman(env, customer, reason) {
  await updateCustomer(env, customer.whatsapp_id, {
    state: STATES.HUMAN_TAKEOVER,
    human_takeover: 1,
    human_reason: reason
  });

  await notifyHuman(env, customer, reason);

  return sendSimpleText(
    env,
    customer.whatsapp_id,
    MSG.human
  );
}

async function sendSimpleText(env, to, body) {
  if (isTestMode(env)) {
    return {
      test: true,
      type: "text",
      to,
      body
    };
  }

  return whatsappRequest(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      body
    }
  });
}

/* -------------------------
   Final order confirmation
-------------------------- */

async function sendFinalOrderConfirmation(env, customer) {
  const order = await getOpenOrder(
    env,
    customer.id
  );

  if (!order) {
    return sendSimpleText(
      env,
      customer.whatsapp_id,
      "找不到当前订单，请重新从网站下单。"
    );
  }

  const items = JSON.parse(
    order.items_json || "[]"
  );

  const address =
    order.address_formatted ||
    customer.address_formatted ||
    customer.address_text ||
    "未确认";

  const phone =
    order.contact_phone ||
    customer.contact_phone ||
    normalizePhone(customer.whatsapp_id);

  const body = MSG.orderConfirm({
    itemsText: itemsToText(items),
    totalText: moneyText(order.subtotal),
    address,
    phone: formatPhone(phone)
  });

  return sendMenu(
    env,
    customer.whatsapp_id,
    body,
    [
      {
        id: ACTIONS.CONFIRM_ORDER,
        title: "确认订单",
        description: "确认以上订单信息"
      },
      {
        id: ACTIONS.HUMAN,
        title: "转人工",
        description: "转接人工客服"
      },
      {
        id: ACTIONS.FOOD_DETAILS,
        title: "询问食物详情",
        description: "转人工咨询食品"
      },
      {
        id: ACTIONS.MODIFY_ORDER,
        title: "修改订单",
        description: "转人工修改订单"
      }
    ]
  );
}

/* -------------------------
   Action handling
-------------------------- */

async function handleAction(env, customer, actionId) {
  if (
    customer.human_takeover ||
    customer.state === STATES.HUMAN_TAKEOVER
  ) {
    return null;
  }

  switch (actionId) {
    case ACTIONS.HUMAN:
      return takeOverHuman(
        env,
        customer,
        "客户主动要求人工"
      );

    case ACTIONS.FOOD_DETAILS:
      return takeOverHuman(
        env,
        customer,
        "客户询问食物详情"
      );

    case ACTIONS.MODIFY_ORDER:
      return takeOverHuman(
        env,
        customer,
        "客户要求修改订单"
      );

    case ACTIONS.ADDRESS_WRONG:
      await updateCustomer(
        env,
        customer.whatsapp_id,
        {
          state: STATES.WAITING_ADDRESS
        }
      );

      return sendMenu(
        env,
        customer.whatsapp_id,
        MSG.addressWrong,
        [
          {
            id: ACTIONS.HUMAN,
            title: "转人工",
            description: "转接人工客服"
          },
          {
            id: ACTIONS.FOOD_DETAILS,
            title: "询问食物详情",
            description: "转人工咨询食品"
          },
          {
            id: ACTIONS.MODIFY_ORDER,
            title: "修改订单",
            description: "转人工修改订单"
          }
        ]
      );

    case ACTIONS.ADDRESS_CORRECT: {
      const order = await getOpenOrder(
        env,
        customer.id
      );

      if (
        !order ||
        !customer.address_formatted
      ) {
        return sendMenu(
          env,
          customer.whatsapp_id,
          MSG.addressWrong,
          [
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        );
      }

      const accountPhone = normalizePhone(
        customer.whatsapp_id
      );

      await updateOpenOrder(
        env,
        customer.id,
        {
          address_formatted:
            customer.address_formatted,
          latitude: customer.latitude,
          longitude: customer.longitude
        }
      );

      if (
        !isValidMYPlus60(accountPhone)
      ) {
        await updateCustomer(
          env,
          customer.whatsapp_id,
          {
            state: STATES.WAITING_PHONE_INPUT
          }
        );

        return sendMenu(
          env,
          customer.whatsapp_id,
          MSG.phoneRejected,
          [
            {
              id: ACTIONS.ADD_PHONE,
              title: "添加联系号码",
              description: "发送 +60 开头的号码"
            },
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        );
      }

      await updateCustomer(
        env,
        customer.whatsapp_id,
        {
          state: STATES.WAITING_PHONE_CONFIRM
        }
      );

      return sendMenu(
        env,
        customer.whatsapp_id,
        MSG.phonePrompt(
          formatPhone(accountPhone)
        ),
        [
          {
            id: ACTIONS.USE_ACCOUNT_PHONE,
            title: "使用本账号联系号码",
            description: "使用当前 WhatsApp 号码"
          },
          {
            id: ACTIONS.ADD_PHONE,
            title: "添加联系号码",
            description: "发送其他 +60 号码"
          },
          {
            id: ACTIONS.HUMAN,
            title: "转人工",
            description: "转接人工客服"
          },
          {
            id: ACTIONS.FOOD_DETAILS,
            title: "询问食物详情"
          },
          {
            id: ACTIONS.MODIFY_ORDER,
            title: "修改订单"
          }
        ]
      );
    }

    case ACTIONS.USE_ACCOUNT_PHONE: {
      const phone = normalizePhone(
        customer.whatsapp_id
      );

      if (!isValidMYPlus60(phone)) {
        await updateCustomer(
          env,
          customer.whatsapp_id,
          {
            state: STATES.WAITING_PHONE_INPUT
          }
        );

        return sendMenu(
          env,
          customer.whatsapp_id,
          MSG.phoneRejected,
          [
            {
              id: ACTIONS.ADD_PHONE,
              title: "添加联系号码"
            },
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        );
      }

      await updateCustomer(
        env,
        customer.whatsapp_id,
        {
          state: STATES.WAITING_ORDER_CONFIRM,
          contact_phone: phone
        }
      );

      await updateOpenOrder(
        env,
        customer.id,
        {
          contact_phone: phone
        }
      );

      const refreshed =
        await getCustomer(
          env,
          customer.whatsapp_id
        );

      return sendFinalOrderConfirmation(
        env,
        refreshed
      );
    }

    case ACTIONS.ADD_PHONE:
      await updateCustomer(
        env,
        customer.whatsapp_id,
        {
          state: STATES.WAITING_PHONE_INPUT
        }
      );

      return sendMenu(
        env,
        customer.whatsapp_id,
        MSG.askPhone,
        [
          {
            id: ACTIONS.HUMAN,
            title: "转人工"
          },
          {
            id: ACTIONS.FOOD_DETAILS,
            title: "询问食物详情"
          },
          {
            id: ACTIONS.MODIFY_ORDER,
            title: "修改订单"
          }
        ]
      );

    case ACTIONS.CONFIRM_ORDER: {
      const order = await getOpenOrder(
        env,
        customer.id
      );

      if (!order) {
        return sendSimpleText(
          env,
          customer.whatsapp_id,
          "找不到当前订单，请重新从网站下单。"
        );
      }

      await env.DB.prepare(`
        UPDATE orders
        SET status = 'CONFIRMED',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
      `)
        .bind(order.id)
        .run();

      await updateCustomer(
        env,
        customer.whatsapp_id,
        {
          state: STATES.COMPLETED
        }
      );

      return sendSimpleText(
        env,
        customer.whatsapp_id,
        MSG.orderDone
      );
    }

    default:
      return null;
  }
}

/* -------------------------
   Address handling
-------------------------- */

async function handleAddressText(
  env,
  customer,
  text
) {
  const addressText =
    String(text || "").trim();

  if (!addressText) {
    return sendMenu(
      env,
      customer.whatsapp_id,
      MSG.addressNotFound,
      [
        {
          id: ACTIONS.HUMAN,
          title: "转人工"
        },
        {
          id: ACTIONS.FOOD_DETAILS,
          title: "询问食物详情"
        },
        {
          id: ACTIONS.MODIFY_ORDER,
          title: "修改订单"
        }
      ]
    );
  }

  const result = await geocodeAddress(
    env,
    addressText
  );

  if (!result) {
    await updateCustomer(
      env,
      customer.whatsapp_id,
      {
        state: STATES.WAITING_ADDRESS
      }
    );

    return sendMenu(
      env,
      customer.whatsapp_id,
      MSG.addressNotFound,
      [
        {
          id: ACTIONS.HUMAN,
          title: "转人工"
        },
        {
          id: ACTIONS.FOOD_DETAILS,
          title: "询问食物详情"
        },
        {
          id: ACTIONS.MODIFY_ORDER,
          title: "修改订单"
        }
      ]
    );
  }

  await updateCustomer(
    env,
    customer.whatsapp_id,
    {
      state: STATES.WAITING_ADDRESS_CONFIRM,
      address_text: addressText,
      address_formatted:
        result.formattedAddress,
      latitude: result.latitude,
      longitude: result.longitude
    }
  );

  await updateOpenOrder(
    env,
    customer.id,
    {
      address_text: addressText,
      address_formatted:
        result.formattedAddress,
      latitude: result.latitude,
      longitude: result.longitude
    }
  );

  await sendLocation(
    env,
    customer.whatsapp_id,
    result
  );

  return sendMenu(
    env,
    customer.whatsapp_id,
    MSG.addressConfirm(
      result.formattedAddress
    ),
    [
      {
        id: ACTIONS.ADDRESS_CORRECT,
        title: "地址正确",
        description: "继续确认联系电话"
      },
      {
        id: ACTIONS.ADDRESS_WRONG,
        title: "地址错误",
        description: "重新发送文字地址"
      },
      {
        id: ACTIONS.HUMAN,
        title: "转人工"
      },
      {
        id: ACTIONS.FOOD_DETAILS,
        title: "询问食物详情"
      },
      {
        id: ACTIONS.MODIFY_ORDER,
        title: "修改订单"
      }
    ]
  );
}

/* -------------------------
   Phone handling
-------------------------- */

async function handlePhoneText(
  env,
  customer,
  text
) {
  const phone = normalizePhone(text);

  if (!isValidMYPlus60(phone)) {
    await updateCustomer(
      env,
      customer.whatsapp_id,
      {
        state: STATES.WAITING_PHONE_INPUT
      }
    );

    return sendMenu(
      env,
      customer.whatsapp_id,
      MSG.phoneRejected,
      [
        {
          id: ACTIONS.ADD_PHONE,
          title: "添加联系号码"
        },
        {
          id: ACTIONS.HUMAN,
          title: "转人工"
        },
        {
          id: ACTIONS.FOOD_DETAILS,
          title: "询问食物详情"
        },
        {
          id: ACTIONS.MODIFY_ORDER,
          title: "修改订单"
        }
      ]
    );
  }

  await updateCustomer(
    env,
    customer.whatsapp_id,
    {
      state: STATES.WAITING_ORDER_CONFIRM,
      contact_phone: phone
    }
  );

  await updateOpenOrder(
    env,
    customer.id,
    {
      contact_phone: phone
    }
  );

  const refreshed =
    await getCustomer(
      env,
      customer.whatsapp_id
    );

  return sendFinalOrderConfirmation(
    env,
    refreshed
  );
}

/* -------------------------
   Incoming text
-------------------------- */

async function handleIncomingText(
  env,
  whatsappId,
  text,
  displayName = null
) {
  const customer =
    await ensureCustomer(
      env,
      whatsappId,
      displayName
    );

  if (
    customer.human_takeover ||
    customer.state === STATES.HUMAN_TAKEOVER
  ) {
    return { replies: [] };
  }

  /*
    New customer or finished customer:
    non-order message -> welcome + order URL
  */
  if (
    [STATES.NEW, STATES.COMPLETED].includes(
      customer.state
    ) &&
    !isOrderText(text)
  ) {
    return {
      replies: [
        await sendMenu(
          env,
          whatsappId,
          MSG.welcome(
            env.ORDER_WEBSITE_URL
          ),
          [
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        )
      ]
    };
  }

  /*
    New order
  */
  if (
    isOrderText(text) &&
    [STATES.NEW, STATES.COMPLETED].includes(
      customer.state
    )
  ) {
    const parsed = parseOrder(text);

    if (!parsed.items.length) {
      return {
        replies: [
          await sendMenu(
            env,
            whatsappId,
            "已收到您的消息，但订单内容似乎无法读取。请重新从网站点击 WhatsApp 下单。",
            [
              {
                id: ACTIONS.HUMAN,
                title: "转人工"
              },
              {
                id: ACTIONS.FOOD_DETAILS,
                title: "询问食物详情"
              },
              {
                id: ACTIONS.MODIFY_ORDER,
                title: "修改订单"
              }
            ]
          )
        ]
      };
    }

    const existingOrder =
      await getOpenOrder(
        env,
        customer.id
      );

    if (!existingOrder) {
      await createOrder(
        env,
        customer.id,
        parsed
      );
    }

    await updateCustomer(
      env,
      whatsappId,
      {
        state: STATES.WAITING_ADDRESS,
        human_takeover: 0,
        human_reason: null
      }
    );

    return {
      replies: [
        await sendMenu(
          env,
          whatsappId,
          MSG.askAddress,
          [
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        )
      ]
    };
  }

  /*
    Waiting for address
  */
  if (
    customer.state === STATES.WAITING_ADDRESS
  ) {
    return {
      replies: [
        await handleAddressText(
          env,
          customer,
          text
        )
      ]
    };
  }

  /*
    Waiting for phone input
  */
  if (
    customer.state === STATES.WAITING_PHONE_INPUT
  ) {
    return {
      replies: [
        await handlePhoneText(
          env,
          customer,
          text
        )
      ]
    };
  }

  /*
    Customer types when they should press address buttons
  */
  if (
    customer.state ===
    STATES.WAITING_ADDRESS_CONFIRM
  ) {
    return {
      replies: [
        await sendMenu(
          env,
          whatsappId,
          "请使用上方的地址操作菜单继续；如需帮助，也可以选择转人工。",
          [
            {
              id: ACTIONS.ADDRESS_CORRECT,
              title: "地址正确"
            },
            {
              id: ACTIONS.ADDRESS_WRONG,
              title: "地址错误"
            },
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        )
      ]
    };
  }

  /*
    Waiting for phone confirmation
  */
  if (
    customer.state ===
    STATES.WAITING_PHONE_CONFIRM
  ) {
    const phone = normalizePhone(
      customer.whatsapp_id
    );

    return {
      replies: [
        await sendMenu(
          env,
          whatsappId,
          MSG.phonePrompt(
            formatPhone(phone)
          ),
          [
            {
              id: ACTIONS.USE_ACCOUNT_PHONE,
              title: "使用本账号联系号码"
            },
            {
              id: ACTIONS.ADD_PHONE,
              title: "添加联系号码"
            },
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        )
      ]
    };
  }

  /*
    Waiting for final confirmation
  */
  if (
    customer.state ===
    STATES.WAITING_ORDER_CONFIRM
  ) {
    return {
      replies: [
        await sendFinalOrderConfirmation(
          env,
          customer
        )
      ]
    };
  }

  return {
    replies: [
      await sendMenu(
        env,
        whatsappId,
        MSG.welcome(
          env.ORDER_WEBSITE_URL
        ),
        [
          {
            id: ACTIONS.HUMAN,
            title: "转人工"
          },
          {
            id: ACTIONS.FOOD_DETAILS,
            title: "询问食物详情"
          },
          {
            id: ACTIONS.MODIFY_ORDER,
            title: "修改订单"
          }
        ]
      )
    ]
  };
}

/* -------------------------
   Real WhatsApp webhook
-------------------------- */

async function handleWhatsAppWebhook(
  env,
  body
) {
  const value =
    body?.entry?.[0]?.changes?.[0]?.value;

  const messages =
    value?.messages || [];

  for (const message of messages) {
    const from = message?.from;

    if (!from) continue;

    const displayName =
      value?.contacts?.[0]?.profile?.name ||
      null;

    const customer =
      await ensureCustomer(
        env,
        from,
        displayName
      );

    /*
      Human takeover means:
      do not reply automatically.
    */
    if (
      customer.human_takeover ||
      customer.state === STATES.HUMAN_TAKEOVER
    ) {
      continue;
    }

    if (message.type === "text") {
      await handleIncomingText(
        env,
        from,
        message.text?.body || "",
        displayName
      );

      continue;
    }

    if (message.type === "location") {
      /*
        Your intended workflow asks for a TEXT address.
        So a native location sent by customer is not
        automatically used here.
      */
      if (
        customer.state ===
        STATES.WAITING_ADDRESS
      ) {
        await sendMenu(
          env,
          from,
          "请直接发送您的配送地址文字信息。\n\n建议提供：门牌号、小区/公寓名称、区域。",
          [
            {
              id: ACTIONS.HUMAN,
              title: "转人工"
            },
            {
              id: ACTIONS.FOOD_DETAILS,
              title: "询问食物详情"
            },
            {
              id: ACTIONS.MODIFY_ORDER,
              title: "修改订单"
            }
          ]
        );
      }

      continue;
    }

    if (message.type === "interactive") {
      const interactive =
        message.interactive;

      const actionId =
        interactive?.button_reply?.id ||
        interactive?.list_reply?.id ||
        null;

      if (!actionId) continue;

      await handleAction(
        env,
        customer,
        actionId
      );
    }
  }
}

/* -------------------------
   Test environment
-------------------------- */

async function resetTest(
  env,
  session
) {
  const customer =
    await getCustomer(
      env,
      session
    );

  if (!customer) return;

  await env.DB.prepare(
    "DELETE FROM orders WHERE customer_id = ?1"
  )
    .bind(customer.id)
    .run();

  await env.DB.prepare(`
    UPDATE customers
    SET state='NEW',
        human_takeover=0,
        human_reason=NULL,
        contact_phone=NULL,
        address_text=NULL,
        address_formatted=NULL,
        latitude=NULL,
        longitude=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE whatsapp_id = ?1
  `)
    .bind(session)
    .run();
}

function createTestEnv(env) {
  return new Proxy(env, {
    get(target, property) {
      if (property === "TEST_MODE") {
        return "true";
      }

      return target[property];
    }
  });
}
async function testMessage(
  env,
  body
) {
  env = createTestEnv(env);
  const session = String(
    body.session ||
      "601122334455"
  );

  const displayName = String(
    body.name ||
      "Test Customer"
  );

  const customer =
    await ensureCustomer(
      env,
      session,
      displayName
    );

  if (
    customer.human_takeover ||
    customer.state === STATES.HUMAN_TAKEOVER
  ) {
    return {
      replies: [],
      state: customer.state,
      human_takeover: true
    };
  }

  if (body.type === "action") {
    const reply =
      await handleAction(
        env,
        customer,
        body.actionId
      );

    const refreshed =
      await getCustomer(
        env,
        session
      );

    return {
      replies: reply ? [reply] : [],
      state: refreshed.state,
      human_takeover:
        Boolean(
          refreshed.human_takeover
        )
    };
  }

  /*
    Testing address recognition:
    in TEST_MODE, the button below simulates
    a successful Google Geocoding result.
  */
  if (
    body.type ===
    "simulated_address"
  ) {
    if (
      customer.state !==
      STATES.WAITING_ADDRESS
    ) {
      return {
        replies: [
          await sendSimpleText(
            env,
            session,
            "当前不是等待地址的步骤。"
          )
        ],
        state: customer.state,
        human_takeover:
          Boolean(
            customer.human_takeover
          )
      };
    }

    const location = {
      formattedAddress:
        body.address ||
        "Sunway Geo Residences, Bandar Sunway, Petaling Jaya",
      latitude: Number(
        body.latitude ?? 3.0698
      ),
      longitude: Number(
        body.longitude ?? 101.6072
      ),
      name:
        body.name ||
        "Sunway Geo Residences"
    };

    await updateCustomer(
      env,
      session,
      {
        state:
          STATES.WAITING_ADDRESS_CONFIRM,
        address_text:
          location.formattedAddress,
        address_formatted:
          location.formattedAddress,
        latitude:
          location.latitude,
        longitude:
          location.longitude
      }
    );

    await updateOpenOrder(
      env,
      customer.id,
      {
        address_text:
          location.formattedAddress,
        address_formatted:
          location.formattedAddress,
        latitude:
          location.latitude,
        longitude:
          location.longitude
      }
    );

    const replies = [
      await sendLocation(
        env,
        session,
        {
          latitude:
            location.latitude,
          longitude:
            location.longitude,
          name:
            location.name,
          address:
            location.formattedAddress
        }
      ),
      await sendMenu(
        env,
        session,
        MSG.addressConfirm(
          location.formattedAddress
        ),
        [
          {
            id: ACTIONS.ADDRESS_CORRECT,
            title: "地址正确"
          },
          {
            id: ACTIONS.ADDRESS_WRONG,
            title: "地址错误"
          },
          {
            id: ACTIONS.HUMAN,
            title: "转人工"
          },
          {
            id: ACTIONS.FOOD_DETAILS,
            title: "询问食物详情"
          },
          {
            id: ACTIONS.MODIFY_ORDER,
            title: "修改订单"
          }
        ]
      )
    ];

    const refreshed =
      await getCustomer(
        env,
        session
      );

    return {
      replies,
      state: refreshed.state,
      human_takeover:
        Boolean(
          refreshed.human_takeover
        )
    };
  }

  const result =
    await handleIncomingText(
      env,
      session,
      body.text || "",
      displayName
    );

  const refreshed =
    await getCustomer(
      env,
      session
    );

  return {
    replies:
      result.replies || [],
    state: refreshed.state,
    human_takeover:
      Boolean(
        refreshed.human_takeover
      )
  };
}

/* -------------------------
   Test page
-------------------------- */

function testPage() {
  return html(`
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>闽南小吃自动接单测试</title>

<style>
body {
  margin: 0;
  padding: 20px;
  font-family: Arial, sans-serif;
  background: #f4f4f4;
}

.wrap {
  max-width: 800px;
  margin: auto;
  background: white;
  border-radius: 14px;
  padding: 20px;
}

.chat {
  height: 520px;
  overflow: auto;
  border: 1px solid #ddd;
  border-radius: 10px;
  padding: 12px;
  background: #fafafa;
}

.msg {
  white-space: pre-wrap;
  padding: 11px 13px;
  border-radius: 10px;
  margin: 10px 0;
}

.user {
  background: #e8f3ff;
}

.bot {
  background: #eee;
}

.system {
  background: #fff4d6;
  font-size: 13px;
  color: #555;
}

.controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

input,
button {
  font-size: 16px;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 8px;
}

input {
  flex: 1;
  min-width: 250px;
}

button {
  cursor: pointer;
  background: white;
}

.note {
  color: #666;
  font-size: 13px;
}
</style>
</head>

<body>

<div class="wrap">

<h2>闽南小吃自动接单测试</h2>

<p class="note">
这是模拟 WhatsApp 测试页面。
不会连接真实 WhatsApp。
</p>

<div class="controls">
  <input
    id="session"
    value="601122334455"
    placeholder="测试客户号码"
  >
</div>

<div id="chat" class="chat"></div>

<div class="controls">
  <input
    id="text"
    placeholder="输入 Hi、订单、地址、+60123456789"
  >

  <button onclick="sendText()">
    发送文字
  </button>
</div>

<div class="controls">

  <button onclick="simulateAddress()">
    模拟成功地址
  </button>

  <button onclick="resetSession()">
    重置客户
  </button>

</div>

<div id="actions" class="controls"></div>

</div>

<script>

const chat =
  document.getElementById("chat");

const textEl =
  document.getElementById("text");

const sessionEl =
  document.getElementById("session");

const actions =
  document.getElementById("actions");

function addMessage(
  role,
  text
) {
  const el =
    document.createElement("div");

  el.className =
    "msg " + role;

  el.textContent = text;

  chat.appendChild(el);

  chat.scrollTop =
    chat.scrollHeight;
}

function renderReplies(
  replies
) {
  actions.innerHTML = "";

  for (
    const reply of replies || []
  ) {

    if (
      reply.type === "text" ||
      reply.type === "menu"
    ) {
      addMessage(
        "bot",
        reply.body
      );

      for (
        const row of
          reply.rows || []
      ) {

        const button =
          document.createElement(
            "button"
          );

        button.textContent =
          row.title;

        button.onclick = () =>
          sendAction(row.id);

        actions.appendChild(
          button
        );
      }
    }

    if (
      reply.type ===
      "location"
    ) {
      addMessage(
        "bot",
        "📍 " +
        (reply.name || "配送位置") +
        "\\n" +
        (reply.address || "") +
        "\\n地图坐标：" +
        reply.latitude +
        ", " +
        reply.longitude
      );
    }
  }
}

async function callApi(
  payload
) {
  const response =
    await fetch(
      "/test/message",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body: JSON.stringify({
          ...payload,
          session:
            sessionEl.value
        })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    addMessage(
      "system",
      "错误：" +
      JSON.stringify(data)
    );
    return;
  }

  renderReplies(
    data.replies
  );

  addMessage(
    "system",
    "[状态：" +
    data.state +
    (
      data.human_takeover
        ? " / 已转人工"
        : ""
    ) +
    "]"
  );
}

async function sendText() {
  const value =
    textEl.value.trim();

  if (!value) return;

  addMessage(
    "user",
    value
  );

  textEl.value = "";

  await callApi({
    type: "text",
    text: value
  });
}

async function sendAction(
  actionId
) {
  addMessage(
    "user",
    "点击：" +
    actionId
  );

  await callApi({
    type: "action",
    actionId
  });
}

async function simulateAddress() {

  addMessage(
    "user",
    "📍 模拟发送文字地址"
  );

  await callApi({
    type:
      "simulated_address",

    address:
      "Sunway Geo Residences, Bandar Sunway, Petaling Jaya",

    latitude:
      3.0698,

    longitude:
      101.6072,

    name:
      "Sunway Geo Residences"
  });
}

async function resetSession() {

  await fetch(
    "/test/reset?session=" +
      encodeURIComponent(
        sessionEl.value
      ),
    {
      method: "POST"
    }
  );

  chat.innerHTML = "";

  actions.innerHTML = "";

  addMessage(
    "system",
    "测试客户已重置。"
  );
}

addMessage(
  "system",
  "开始测试：先发送 Hi。"
);

</script>

</body>
</html>
`);
}

/* -------------------------
   Webhook verification
-------------------------- */

function verifyWebhook(
  request,
  env
) {
  const url =
    new URL(request.url);

  const mode =
    url.searchParams.get(
      "hub.mode"
    );

  const token =
    url.searchParams.get(
      "hub.verify_token"
    );

  const challenge =
    url.searchParams.get(
      "hub.challenge"
    );

  if (
    mode === "subscribe" &&
    token &&
    token ===
      env.WHATSAPP_VERIFY_TOKEN
  ) {
    return new Response(
      challenge || "",
      {
        status: 200
      }
    );
  }

  return new Response(
    "Forbidden",
    {
      status: 403
    }
  );
}

/* -------------------------
   Worker entry
-------------------------- */

export default {
  async fetch(
    request,
    env
  ) {
    try {
      const url =
        new URL(request.url);

      /*
        Health check
      */
      if (
        url.pathname === "/" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          service:
            "minnan-whatsapp-order-bot",
          mode:
            isTestMode(env)
              ? "TEST"
              : "LIVE"
        });
      }

      /*
        Test page
      */
      if (
        url.pathname === "/test" &&
        request.method === "GET"
      ) {
        return testPage();
      }

      /*
        Test message API
      */
      if (
        url.pathname ===
          "/test/message" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const result =
          await testMessage(
            env,
            body
          );

        return json(result);
      }

      /*
        Reset test customer
      */
      if (
        url.pathname ===
          "/test/reset" &&
        request.method === "POST"
      ) {
        const session =
          url.searchParams.get(
            "session"
          );

        if (!session) {
          return json(
            {
              error:
                "session is required"
            },
            400
          );
        }

        await resetTest(
          env,
          session
        );

        return json({
          ok: true
        });
      }

      /*
        WhatsApp webhook verification
      */
      if (
        url.pathname ===
          "/webhook" &&
        request.method === "GET"
      ) {
        return verifyWebhook(
          request,
          env
        );
      }

      /*
        WhatsApp webhook event
      */
      if (
        url.pathname ===
          "/webhook" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        console.log(
          "WhatsApp webhook:",
          JSON.stringify(body)
        );

        await handleWhatsAppWebhook(
          env,
          body
        );

        return new Response(
          "EVENT_RECEIVED",
          {
            status: 200
          }
        );
      }

      return new Response(
        "Not Found",
        {
          status: 404
        }
      );

    } catch (error) {

      console.error(error);

      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
