// 上市公司对比板块配置
// 所有计算均在 app.js 运行时基于平台主数据 data.js / reg_industry.js 完成，
// 不再依赖任何 Excel 或预生成的静态数据。更新 data.js（如新增某期）后本板块自动更新。
window.CMP_CONFIG = {
  // 板块顺序（决定 Tab 与渲染顺序）
  segs: ['group', 'life', 'property'],
  blocks: {
    group: {
      title: '一、保险集团（控股公司）',
      dataBlock: 'group',            // 对应 data.js 的 SOLVENCY_DATA.segments.key
      // 明细公司（上市公司集团，含阳光以与实体行区分）
      companies: ['平安集团', '人保集团', '太保集团', '太平集团', '阳光集团'],
      entities: [
        { name: '集团加权平均(计算口径)', src: 'calc_group' },
        { name: '上市集团加权平均', src: 'agg', block: '集团', excl: 'listedExclSun' },
        { name: '阳光集团', src: 'sun', block: '集团', company: '阳光集团' }
      ],
      // 计算口径公司名单
      lists: {
        listedExclSun: ['平安集团', '人保集团', '太保集团', '太平集团'],      // 上市平均（剔除阳光系）
        allForCalc:   ['平安集团', '人保集团', '太保集团', '太平集团', '阳光集团'] // 计算口径（含阳光）
      }
    },
    life: {
      title: '二、人身险公司',
      dataBlock: 'life',
      companies: ['平安寿险', '人保寿险', '太保寿险', '太平人寿', '中国人寿', '新华保险', '阳光人寿'],
      entities: [
        { name: '人身险行业加权平均(监管披露口径)', src: 'reg', seg: 'life' },
        { name: '上市人身险公司平均', src: 'agg', block: '寿险', excl: 'listedExclSun' },
        { name: '银保系平均', src: 'bank' },
        { name: '阳光人寿', src: 'sun', block: '寿险', company: '阳光人寿' }
      ],
      lists: {
        listedExclSun: ['平安寿险', '人保寿险', '太保寿险', '太平人寿', '中国人寿', '新华保险'],
        banks: ['工银安盛', '光大永明', '建信人寿', '交银人寿', '中荷人寿', '农银人寿', '中银三星', '中邮人寿', '招商信诺']
      }
    },
    property: {
      title: '三、财产险公司',
      dataBlock: 'property',
      companies: ['平安产险', '人保财险', '太保财险', '太平财险', '众安财产', '大地财产', '阳光财产'],
      entities: [
        { name: '财险行业加权平均(监管披露口径)', src: 'reg', seg: 'property' },
        { name: '上市财险平均(含众安)', src: 'agg', block: '产险', excl: 'listedInclZhongan' },
        { name: '上市财险平均(不含众安)', src: 'agg', block: '产险', excl: 'listedExclZhongan' },
        { name: '阳光财险', src: 'sun', block: '产险', company: '阳光财产' }
      ],
      lists: {
        listedInclZhongan: ['平安产险', '人保财险', '太保财险', '太平财险', '众安财产', '大地财产'],
        listedExclZhongan: ['平安产险', '人保财险', '太保财险', '太平财险', '大地财产']
      }
    }
  }
};
